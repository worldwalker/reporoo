import type {
  ProductDefinition,
  RepositoryDefinition,
} from "./registry.js";
import { ProductRegistry } from "./registry.js";

export type RepositorySelection = {
  product: ProductDefinition;
  repository: RepositoryDefinition;
};

export type RouteResult =
  | {
      kind: "clarification_required";
      products: readonly ProductDefinition[];
    }
  | {
      kind: "selected";
      products: readonly ProductDefinition[];
      repositories: readonly RepositorySelection[];
    };

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalize(text)} `;
  const normalizedPhrase = normalize(phrase);
  return normalizedPhrase.length > 0 && normalizedText.includes(` ${normalizedPhrase} `);
}

function productMatches(question: string, product: ProductDefinition): boolean {
  return [product.id, product.name, ...product.aliases].some((alias) =>
    containsPhrase(question, alias),
  );
}

function selectRepositories(
  question: string,
  product: ProductDefinition,
): RepositoryDefinition[] {
  const matches = product.repositories.filter((repository) =>
    [repository.id, repository.component, ...repository.aliases, ...repository.topics].some((alias) =>
      containsPhrase(question, alias),
    ),
  );

  if (matches.length === 0) return [...product.repositories];

  const selectedIds = new Set(matches.map((repository) => repository.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const repository of product.repositories) {
      if (!selectedIds.has(repository.id)) continue;
      for (const relatedId of repository.includeWith) {
        if (!selectedIds.has(relatedId)) {
          selectedIds.add(relatedId);
          changed = true;
        }
      }
    }
  }

  return product.repositories.filter((repository) => selectedIds.has(repository.id));
}

export function routeQuestion(
  question: string,
  registry: ProductRegistry,
  inheritedProductIds: readonly string[] = [],
): RouteResult {
  const explicitProducts = registry.products.filter((product) =>
    productMatches(question, product),
  );

  const inheritedProducts = inheritedProductIds
    .map((id) => registry.get(id))
    .filter((product): product is ProductDefinition => product !== undefined);

  const products = explicitProducts.length > 0 ? explicitProducts : inheritedProducts;
  if (products.length === 0) {
    return { kind: "clarification_required", products: registry.products };
  }

  return {
    kind: "selected",
    products,
    repositories: products.flatMap((product) =>
      selectRepositories(question, product).map((repository) => ({
        product,
        repository,
      })),
    ),
  };
}
