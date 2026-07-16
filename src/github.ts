import { access, mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { RepositoryDefinition } from "./registry.js";
import { logger } from "./logger.js";
import { runCommand } from "./process.js";

export type RepositorySnapshot = {
  directory: string;
  commit: string;
  github: string;
  component: string;
};

export type GitHubRepositoryInfo = {
  github: string;
  defaultBranch: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class GitHubSnapshots {
  private readonly lastSync = new Map<string, number>();

  constructor(
    private readonly cacheDirectory: string,
    private readonly syncTtlMs: number,
  ) {}

  async assertReady(): Promise<void> {
    await runCommand("git", ["--version"]);
    await runCommand("gh", ["--version"]);
    await runCommand("gh", ["auth", "status"]);
    logger.info("github.ready");
  }

  async inspectRepository(github: string): Promise<GitHubRepositoryInfo> {
    const output = await runCommand("gh", [
      "repo",
      "view",
      github,
      "--json",
      "nameWithOwner,defaultBranchRef",
    ]);
    const parsed = JSON.parse(output) as {
      nameWithOwner?: string;
      defaultBranchRef?: { name?: string } | null;
    };
    if (!parsed.nameWithOwner || !parsed.defaultBranchRef?.name) {
      throw new Error(`Could not read repository metadata for ${github}`);
    }
    const info = {
      github: parsed.nameWithOwner,
      defaultBranch: parsed.defaultBranchRef.name,
    };
    logger.info("github.repository_verified", info);
    return info;
  }

  async sync(
    productId: string,
    repository: RepositoryDefinition,
  ): Promise<RepositorySnapshot> {
    const root = resolve(this.cacheDirectory);
    const directory = resolve(root, productId, repository.id);
    if (!directory.startsWith(`${root}${sep}`)) {
      throw new Error("Repository cache path escaped its configured root");
    }

    const cacheKey = `${productId}/${repository.id}`;
    const lastSyncAt = this.lastSync.get(cacheKey) ?? 0;
    const fresh = Date.now() - lastSyncAt < this.syncTtlMs;

    await mkdir(resolve(directory, ".."), { recursive: true });
    if (!(await exists(resolve(directory, ".git")))) {
      const startedAt = Date.now();
      logger.info("repository.clone_started", { repository: repository.github });
      await runCommand("gh", [
        "repo",
        "clone",
        repository.github,
        directory,
        "--",
        "--branch",
        repository.defaultBranch,
        "--single-branch",
      ]);
      this.lastSync.set(cacheKey, Date.now());
      logger.info("repository.clone_completed", {
        repository: repository.github,
        durationMs: Date.now() - startedAt,
      });
    } else if (!fresh) {
      const startedAt = Date.now();
      logger.info("repository.refresh_started", { repository: repository.github });
      await runCommand("git", [
        "-C",
        directory,
        "fetch",
        "--quiet",
        "--prune",
        "origin",
        repository.defaultBranch,
      ]);
      await runCommand("git", [
        "-C",
        directory,
        "checkout",
        "--quiet",
        "--detach",
        "FETCH_HEAD",
      ]);
      this.lastSync.set(cacheKey, Date.now());
      logger.info("repository.refresh_completed", {
        repository: repository.github,
        durationMs: Date.now() - startedAt,
      });
    }

    const commit = await runCommand("git", ["-C", directory, "rev-parse", "HEAD"]);
    return {
      directory,
      commit,
      github: repository.github,
      component: repository.component,
    };
  }
}
