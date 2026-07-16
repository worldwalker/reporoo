import { resolve } from "node:path";
import { z } from "zod";

const integerList = z.preprocess((raw) => raw ?? "", z.string().transform((value, context) => {
  if (!value.trim()) return [] as number[];

  const values = value.split(",").map((item) => Number(item.trim()));
  if (values.some((item) => !Number.isSafeInteger(item))) {
    context.addIssue({
      code: "custom",
      message: "Expected a comma-separated list of Telegram numeric IDs",
    });
    return z.NEVER;
  }

  return values;
}));

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_IDS: integerList,
  TELEGRAM_ADMIN_USER_IDS: integerList,
  REGISTRY_DATABASE: z.string().default("./data/registry.sqlite"),
  REPOSITORY_CACHE_DIR: z.string().default("./data/repositories"),
  MAX_REPOSITORIES_PER_QUESTION: z.coerce.number().int().min(1).max(20).default(5),
  REPOSITORY_SYNC_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(6),
  CODEX_MODEL: z.string().default(""),
});

export type AppConfig = {
  telegramBotToken: string;
  allowedChatIds: ReadonlySet<number>;
  adminUserIds: ReadonlySet<number>;
  registryDatabasePath: string;
  repositoryCacheDirectory: string;
  maxRepositoriesPerQuestion: number;
  repositorySyncTtlMs: number;
  rateLimitPerMinute: number;
  codexModel: string | undefined;
};

export function loadAppConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const parsed = environmentSchema.parse(environment);

  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    allowedChatIds: new Set(parsed.TELEGRAM_ALLOWED_CHAT_IDS),
    adminUserIds: new Set(parsed.TELEGRAM_ADMIN_USER_IDS),
    registryDatabasePath: resolve(workingDirectory, parsed.REGISTRY_DATABASE),
    repositoryCacheDirectory: resolve(workingDirectory, parsed.REPOSITORY_CACHE_DIR),
    maxRepositoriesPerQuestion: parsed.MAX_REPOSITORIES_PER_QUESTION,
    repositorySyncTtlMs: parsed.REPOSITORY_SYNC_TTL_SECONDS * 1_000,
    rateLimitPerMinute: parsed.RATE_LIMIT_PER_MINUTE,
    codexModel: parsed.CODEX_MODEL.trim() || undefined,
  };
}
