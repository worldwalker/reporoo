import "dotenv/config";
import { CodexAnalyst } from "./codex.js";
import { loadAppConfig } from "./config.js";
import { GitHubSnapshots } from "./github.js";
import { logger } from "./logger.js";
import { QuestionAnswerService } from "./qa-service.js";
import { ProductRegistry } from "./registry.js";
import { RepoRooTelegramBot } from "./telegram.js";

process.on("uncaughtException", (error) => {
  logger.error("process.uncaught_exception", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandled_rejection", reason);
  process.exit(1);
});

async function main(): Promise<void> {
  const config = loadAppConfig();
  const registry = ProductRegistry.open(config.registryDatabasePath);
  logger.info("app.starting", {
    products: registry.products.length,
    repositories: registry.products.reduce(
      (count, product) => count + product.repositories.length,
      0,
    ),
  });
  const snapshots = new GitHubSnapshots(
    config.repositoryCacheDirectory,
    config.repositorySyncTtlMs,
  );
  const analyst = new CodexAnalyst(config.codexModel);
  const qa = new QuestionAnswerService(
    snapshots,
    analyst,
    config.maxRepositoriesPerQuestion,
  );
  const bot = new RepoRooTelegramBot(config, registry, qa);

  const stop = (): void => bot.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bot.start();
}

main().catch((error: unknown) => {
  logger.error("app.start_failed", error);
  process.exitCode = 1;
});
