import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AnalystProvider } from "./analyst.js";

export type RepositoryDefinition = {
  id: string;
  github: string;
  component: string;
  aliases: string[];
  topics: string[];
  includeWith: string[];
  defaultBranch: string;
};

export type ProductDefinition = {
  id: string;
  name: string;
  aliases: string[];
  repositories: RepositoryDefinition[];
};

type ProductRow = { id: string; name: string };
type RepositoryRow = {
  row_id: number;
  product_id: string;
  id: string;
  github: string;
  component: string;
  default_branch: string;
};
type ValueRow = { owner_id: string | number; value: string };
type LinkRow = { repository_id: number; included_id: string };
type ProviderPreferenceRow = { provider: string };

function slugify(value: string): string {
  return value
    .toLocaleLowerCase("en")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function cleanValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export class ProductRegistry {
  private productsCache: ProductDefinition[] = [];

  constructor(private readonly database: DatabaseSync) {
    this.createSchema();
    this.refresh();
  }

  static open(path: string): ProductRegistry {
    mkdirSync(dirname(path), { recursive: true });
    return new ProductRegistry(new DatabaseSync(path));
  }

  get products(): readonly ProductDefinition[] {
    return this.productsCache;
  }

  get(productId: string): ProductDefinition | undefined {
    return this.productsCache.find((product) => product.id === productId);
  }

  findProduct(reference: string): ProductDefinition | undefined {
    const normalized = reference.trim().toLocaleLowerCase("en");
    return this.productsCache.find(
      (product) =>
        product.id.toLocaleLowerCase("en") === normalized ||
        product.name.toLocaleLowerCase("en") === normalized ||
        product.aliases.some((alias) => alias.toLocaleLowerCase("en") === normalized),
    );
  }

  require(productId: string): ProductDefinition {
    const product = this.get(productId);
    if (!product) throw new Error(`Unknown product: ${productId}`);
    return product;
  }

  getAnalystProvider(platform: string, userId: string | number): AnalystProvider {
    const row = this.database
      .prepare(
        `SELECT provider FROM analyst_preferences
         WHERE platform = ? AND user_id = ?`,
      )
      .get(platform, String(userId)) as ProviderPreferenceRow | undefined;
    return row?.provider === "claude" ? "claude" : "codex";
  }

  setAnalystProvider(
    platform: string,
    userId: string | number,
    provider: AnalystProvider,
  ): void {
    this.database
      .prepare(
        `INSERT INTO analyst_preferences (platform, user_id, provider)
         VALUES (?, ?, ?)
         ON CONFLICT (platform, user_id)
         DO UPDATE SET provider = excluded.provider, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(platform, String(userId), provider);
  }

  addProduct(name: string, createdBy: number): ProductDefinition {
    const cleanName = name.trim();
    const id = slugify(cleanName);
    if (!id) throw new Error("Product name must contain letters or numbers.");
    if (this.findProduct(cleanName) || this.get(id)) {
      throw new Error(`Product “${cleanName}” already exists.`);
    }

    this.database
      .prepare("INSERT INTO products (id, name, created_by) VALUES (?, ?, ?)")
      .run(id, cleanName, createdBy);
    this.refresh();
    return this.require(id);
  }

  addProductAliases(reference: string, aliases: readonly string[]): ProductDefinition {
    const product = this.findProduct(reference);
    if (!product) throw new Error(`Unknown product: ${reference}`);
    const insert = this.database.prepare(
      "INSERT OR IGNORE INTO product_aliases (product_id, alias) VALUES (?, ?)",
    );
    for (const alias of cleanValues(aliases)) insert.run(product.id, alias);
    this.refresh();
    return this.require(product.id);
  }

  removeProduct(reference: string): string {
    const product = this.findProduct(reference);
    if (!product) throw new Error(`Unknown product: ${reference}`);
    this.database.prepare("DELETE FROM products WHERE id = ?").run(product.id);
    this.refresh();
    return product.name;
  }

  addRepository(input: {
    productReference: string;
    github: string;
    component?: string;
    defaultBranch: string;
    createdBy: number;
  }): RepositoryDefinition {
    const product = this.findProduct(input.productReference);
    if (!product) throw new Error(`Unknown product: ${input.productReference}`);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.github)) {
      throw new Error("Repository must use owner/name format.");
    }
    if (this.findRepository(input.github)) {
      throw new Error(`Repository ${input.github} already exists.`);
    }

    const baseId = slugify(input.github.split("/")[1] ?? "repo") || "repo";
    let id = baseId;
    let suffix = 2;
    while (product.repositories.some((repository) => repository.id === id)) {
      id = `${baseId.slice(0, 28)}-${suffix++}`;
    }

    this.database
      .prepare(
        `INSERT INTO repositories
          (product_id, id, github, component, default_branch, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        product.id,
        id,
        input.github,
        input.component?.trim() || input.github.split("/")[1] || "repository",
        input.defaultBranch,
        input.createdBy,
      );
    this.refresh();
    return this.requireRepository(input.github).repository;
  }

  addRepositoryAliases(github: string, aliases: readonly string[]): RepositoryDefinition {
    return this.addRepositoryValues("repository_aliases", github, aliases);
  }

  setRepositoryTopics(github: string, topics: readonly string[]): RepositoryDefinition {
    const found = this.requireRepository(github);
    this.database.prepare("DELETE FROM repository_topics WHERE repository_id = ?").run(found.rowId);
    const insert = this.database.prepare(
      "INSERT INTO repository_topics (repository_id, topic) VALUES (?, ?)",
    );
    for (const topic of cleanValues(topics)) insert.run(found.rowId, topic);
    this.refresh();
    return this.requireRepository(github).repository;
  }

  setRepositoryComponent(github: string, component: string): RepositoryDefinition {
    const found = this.requireRepository(github);
    const value = component.trim();
    if (!value) throw new Error("Component description cannot be empty.");
    this.database
      .prepare("UPDATE repositories SET component = ? WHERE row_id = ?")
      .run(value, found.rowId);
    this.refresh();
    return this.requireRepository(github).repository;
  }

  setRepositoryBranch(github: string, branch: string): RepositoryDefinition {
    const found = this.requireRepository(github);
    const value = branch.trim();
    if (!value) throw new Error("Branch cannot be empty.");
    this.database
      .prepare("UPDATE repositories SET default_branch = ? WHERE row_id = ?")
      .run(value, found.rowId);
    this.refresh();
    return this.requireRepository(github).repository;
  }

  linkRepositories(github: string, includedGithub: string): RepositoryDefinition {
    const source = this.requireRepository(github);
    const included = this.requireRepository(includedGithub);
    if (source.productId !== included.productId) {
      throw new Error("Linked repositories must belong to the same product.");
    }
    this.database
      .prepare(
        "INSERT OR IGNORE INTO repository_links (repository_id, included_repository_id) VALUES (?, ?)",
      )
      .run(source.rowId, included.rowId);
    this.refresh();
    return this.requireRepository(github).repository;
  }

  removeRepository(github: string): string {
    const found = this.requireRepository(github);
    this.database.prepare("DELETE FROM repositories WHERE row_id = ?").run(found.rowId);
    this.refresh();
    return found.repository.github;
  }

  findRepository(github: string):
    | { product: ProductDefinition; repository: RepositoryDefinition }
    | undefined {
    const normalized = github.trim().toLocaleLowerCase("en");
    for (const product of this.productsCache) {
      const repository = product.repositories.find(
        (item) => item.github.toLocaleLowerCase("en") === normalized,
      );
      if (repository) return { product, repository };
    }
    return undefined;
  }

  private requireRepository(github: string): {
    productId: string;
    rowId: number;
    repository: RepositoryDefinition;
  } {
    const found = this.findRepository(github);
    if (!found) throw new Error(`Unknown repository: ${github}`);
    const row = this.database
      .prepare("SELECT row_id FROM repositories WHERE github = ? COLLATE NOCASE")
      .get(found.repository.github) as { row_id: number } | undefined;
    if (!row) throw new Error(`Unknown repository: ${github}`);
    return { productId: found.product.id, rowId: row.row_id, repository: found.repository };
  }

  private addRepositoryValues(
    table: "repository_aliases",
    github: string,
    values: readonly string[],
  ): RepositoryDefinition {
    const found = this.requireRepository(github);
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO ${table} (repository_id, alias) VALUES (?, ?)`,
    );
    for (const value of cleanValues(values)) insert.run(found.rowId, value);
    this.refresh();
    return this.requireRepository(github).repository;
  }

  private createSchema(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS product_aliases (
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        alias TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (product_id, alias)
      );
      CREATE TABLE IF NOT EXISTS repositories (
        row_id INTEGER PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        github TEXT NOT NULL UNIQUE COLLATE NOCASE,
        component TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (product_id, id)
      );
      CREATE TABLE IF NOT EXISTS repository_aliases (
        repository_id INTEGER NOT NULL REFERENCES repositories(row_id) ON DELETE CASCADE,
        alias TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (repository_id, alias)
      );
      CREATE TABLE IF NOT EXISTS repository_topics (
        repository_id INTEGER NOT NULL REFERENCES repositories(row_id) ON DELETE CASCADE,
        topic TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (repository_id, topic)
      );
      CREATE TABLE IF NOT EXISTS repository_links (
        repository_id INTEGER NOT NULL REFERENCES repositories(row_id) ON DELETE CASCADE,
        included_repository_id INTEGER NOT NULL REFERENCES repositories(row_id) ON DELETE CASCADE,
        PRIMARY KEY (repository_id, included_repository_id)
      );
      CREATE TABLE IF NOT EXISTS analyst_preferences (
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (platform, user_id)
      );
    `);
  }

  private refresh(): void {
    const products = this.database
      .prepare("SELECT id, name FROM products ORDER BY name COLLATE NOCASE")
      .all() as ProductRow[];
    const repositories = this.database
      .prepare(
        `SELECT row_id, product_id, id, github, component, default_branch
         FROM repositories ORDER BY github COLLATE NOCASE`,
      )
      .all() as RepositoryRow[];
    const productAliases = this.database
      .prepare("SELECT product_id AS owner_id, alias AS value FROM product_aliases")
      .all() as ValueRow[];
    const repositoryAliases = this.database
      .prepare("SELECT repository_id AS owner_id, alias AS value FROM repository_aliases")
      .all() as ValueRow[];
    const repositoryTopics = this.database
      .prepare("SELECT repository_id AS owner_id, topic AS value FROM repository_topics")
      .all() as ValueRow[];
    const repositoryLinks = this.database
      .prepare(
        `SELECT links.repository_id, included.id AS included_id
         FROM repository_links links
         JOIN repositories included ON included.row_id = links.included_repository_id`,
      )
      .all() as LinkRow[];

    this.productsCache = products.map((product) => ({
      id: product.id,
      name: product.name,
      aliases: productAliases
        .filter((row) => row.owner_id === product.id)
        .map((row) => row.value),
      repositories: repositories
        .filter((repository) => repository.product_id === product.id)
        .map((repository) => ({
          id: repository.id,
          github: repository.github,
          component: repository.component,
          defaultBranch: repository.default_branch,
          aliases: repositoryAliases
            .filter((row) => row.owner_id === repository.row_id)
            .map((row) => row.value),
          topics: repositoryTopics
            .filter((row) => row.owner_id === repository.row_id)
            .map((row) => row.value),
          includeWith: repositoryLinks
            .filter((row) => row.repository_id === repository.row_id)
            .map((row) => row.included_id),
        })),
    }));
  }
}
