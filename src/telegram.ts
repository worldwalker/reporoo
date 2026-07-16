import { randomUUID } from "node:crypto";
import { Bot, Context, InlineKeyboard } from "grammy";
import type { AnalystProvider } from "./analyst.js";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { QuestionAnswerService } from "./qa-service.js";
import { ProductRegistry } from "./registry.js";
import { routeQuestion } from "./router.js";

type PendingQuestion = {
  chatId: number;
  userId: number;
  question: string;
  replyToMessageId: number;
  expiresAt: number;
  logContext: QuestionLogContext;
  provider: AnalystProvider;
};

type AnswerContext = {
  productIds: readonly string[];
  technicalDetails: string;
  expiresAt: number;
};

type ManagementCommand = {
  resource: "product" | "repo";
  arguments: string;
};

type QuestionLogContext = {
  requestId: string;
  startedAt: number;
  userId: number;
};

function contextKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateTelegramMessage(value: string): string {
  const limit = 3_900;
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}\n\n…answer shortened`;
}

const PENDING_QUESTION_TTL_MS = 10 * 60 * 1_000;
const ANSWER_CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;
const STATE_PRUNE_INTERVAL_MS = 60 * 1_000;

export class RepoRooTelegramBot {
  private readonly bot: Bot;
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly answerContexts = new Map<string, AnswerContext>();
  private readonly requestTimes = new Map<number, number[]>();
  private lastStatePruneAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly registry: ProductRegistry,
    private readonly qa: QuestionAnswerService,
  ) {
    this.bot = new Bot(config.telegramBotToken);
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.qa.assertReady();
    logger.info("dependencies.ready");
    await this.bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: (botInfo) => {
        logger.info("telegram.started", { username: botInfo.username });
      },
    });
  }

  stop(): void {
    logger.info("telegram.stopping");
    this.bot.stop();
  }

  private registerHandlers(): void {
    this.bot.on("message:text", async (context) => {
      this.pruneExpiredState();
      if (!this.isAllowedChat(context.chat.id)) return;

      const text = context.message.text.trim();
      const modelCommand = this.parseModelCommand(text, context.me.username);
      if (modelCommand !== undefined) {
        await this.handleModelCommand(context, modelCommand);
        return;
      }

      const managementCommand = this.parseManagementCommand(text, context.me.username);
      if (managementCommand) {
        await this.handleManagementCommand(context, managementCommand);
        return;
      }

      if (this.isDetailsCommand(text, context.me.username)) {
        await this.showDetails(context);
        return;
      }

      if (!this.wasInvoked(context)) return;
      if (!this.consumeRateLimit(context.from.id)) {
        logger.warn("question.rate_limited", {
          chatId: context.chat.id,
          userId: context.from.id,
        });
        await context.reply("RepoRoo needs a tiny breather. Please try again in a minute.");
        return;
      }

      const question = this.extractQuestion(text, context.me.username);
      if (!question) {
        await context.reply(
          `Ask me like: @${context.me.username} Acme Shop: What happens when an order is cancelled?`,
        );
        return;
      }

      const logContext: QuestionLogContext = {
        requestId: randomUUID().replaceAll("-", "").slice(0, 12),
        startedAt: Date.now(),
        userId: context.from.id,
      };
      logger.info("question.received", {
        requestId: logContext.requestId,
        chatId: context.chat?.id,
        userId: logContext.userId,
        characters: question.length,
      });

      const provider = this.providerFor(context.from.id);
      const inherited = this.inheritedProductIds(context);
      const route = routeQuestion(question, this.registry, inherited);
      if (route.kind === "clarification_required") {
        logger.info("question.clarification_requested", {
          requestId: logContext.requestId,
          choices: route.products.length,
        });
        await this.askForProduct(context, question, logContext, provider);
        return;
      }

      await this.answerQuestion(context, question, route, logContext, provider);
    });

    this.bot.on("callback_query:data", async (context) => {
      this.pruneExpiredState();
      const match = /^product:([a-f0-9]{8}):([a-z0-9_-]{1,32})$/.exec(
        context.callbackQuery.data,
      );
      if (!match) return;

      const [, token, productId] = match;
      if (!token || !productId) return;
      const pending = this.pendingQuestions.get(token);
      if (!pending || pending.expiresAt < Date.now()) {
        await context.answerCallbackQuery({ text: "That question expired. Please ask again." });
        this.pendingQuestions.delete(token);
        return;
      }

      if (context.from.id !== pending.userId || context.chat?.id !== pending.chatId) {
        logger.warn("question.clarification_denied", {
          requestId: pending.logContext.requestId,
          userId: context.from.id,
        });
        await context.answerCallbackQuery({ text: "Only the person who asked can choose." });
        return;
      }

      const product = this.registry.get(productId);
      if (!product) {
        await context.answerCallbackQuery({ text: "That product is no longer configured." });
        return;
      }

      this.pendingQuestions.delete(token);
      await context.answerCallbackQuery({ text: `Checking ${product.name}` });
      const route = routeQuestion(pending.question, this.registry, [product.id]);
      if (route.kind !== "selected") return;
      await this.answerQuestion(
        context,
        pending.question,
        route,
        pending.logContext,
        pending.provider,
        pending.replyToMessageId,
      );
    });

    this.bot.catch((error) => {
      logger.error("telegram.update_failed", error.error);
    });
  }

  private isAllowedChat(chatId: number): boolean {
    return this.config.allowedChatIds.has(chatId);
  }

  private parseModelCommand(text: string, username: string): string | undefined {
    const match = new RegExp(
      `^/model(?:@${escapeRegExp(username)})?(?:\\s+(.*))?$`,
      "iu",
    ).exec(text);
    return match ? match[1]?.trim() ?? "" : undefined;
  }

  private async handleModelCommand(
    context: Context & { message: NonNullable<Context["message"]> },
    argument: string,
  ): Promise<void> {
    const userId = context.from?.id;
    if (!userId) return;

    const current = this.providerFor(userId);
    if (!argument) {
      await context.reply(
        `Your analyst is ${this.providerLabel(current)}. Available: ${this.qa.availableProviders.map((provider) => this.providerLabel(provider)).join(", ")}.\n\nChange it with /model codex or /model claude.`,
        { reply_parameters: { message_id: context.message.message_id } },
      );
      return;
    }

    const normalized = argument.toLocaleLowerCase("en");
    if (normalized !== "codex" && normalized !== "claude") {
      await context.reply("Usage: /model codex or /model claude.");
      return;
    }

    if (!this.qa.hasProvider(normalized)) {
      await context.reply(
        `${this.providerLabel(normalized)} is not configured on this RepoRoo deployment.`,
      );
      return;
    }

    this.registry.setAnalystProvider("telegram", userId, normalized);
    logger.info("analyst.preference_changed", { userId, provider: normalized });
    await context.reply(`Done. Your questions will use ${this.providerLabel(normalized)}.`);
  }

  private providerFor(userId: number): AnalystProvider {
    const preferred = this.registry.getAnalystProvider("telegram", userId);
    return this.qa.hasProvider(preferred) ? preferred : "codex";
  }

  private providerLabel(provider: AnalystProvider): string {
    return provider === "claude" ? "Claude" : "Codex";
  }

  private parseManagementCommand(text: string, username: string): ManagementCommand | undefined {
    const match = new RegExp(
      `^/(product|repo)(?:@${escapeRegExp(username)})?(?:\\s+(.*))?$`,
      "iu",
    ).exec(text);
    if (!match?.[1]) return undefined;
    return {
      resource: match[1].toLocaleLowerCase("en") as ManagementCommand["resource"],
      arguments: match[2]?.trim() ?? "",
    };
  }

  private async handleManagementCommand(
    context: Context & { message: NonNullable<Context["message"]> },
    command: ManagementCommand,
  ): Promise<void> {
    const userId = context.from?.id;
    if (!userId || !this.config.adminUserIds.has(userId)) {
      logger.warn("admin.command_denied", {
        chatId: context.chat?.id,
        userId,
        resource: command.resource,
      });
      await context.reply("Only RepoRoo administrators can change products and repositories.");
      return;
    }

    try {
      const response =
        command.resource === "product"
          ? this.handleProductCommand(command.arguments, userId)
          : await this.handleRepositoryCommand(command.arguments, userId);
      await context.reply(truncateTelegramMessage(response), {
        reply_parameters: { message_id: context.message.message_id },
      });
      logger.info("admin.command_completed", {
        chatId: context.chat?.id,
        userId,
        resource: command.resource,
        action: command.arguments.split(/\s+/u)[0] || "help",
      });
    } catch (error) {
      logger.error("admin.command_failed", error, {
        chatId: context.chat?.id,
        userId,
        resource: command.resource,
        action: command.arguments.split(/\s+/u)[0] || "help",
      });
      const message = error instanceof Error ? error.message : "Unknown error";
      await context.reply(`Could not update the registry: ${message}`, {
        reply_parameters: { message_id: context.message.message_id },
      });
    }
  }

  private handleProductCommand(argumentsText: string, adminUserId: number): string {
    const [rawAction = "help", ...rest] = argumentsText.split(/\s+/u);
    const action = rawAction.toLocaleLowerCase("en");
    const value = rest.join(" ").trim();

    if (action === "add") {
      if (!value) return "Usage: /product add Product Name";
      const product = this.registry.addProduct(value, adminUserId);
      return `Created ${product.name}. Its ID is ${product.id}.\n\nNext: /repo add ${product.id} owner/repository`;
    }

    if (action === "alias") {
      const match = /^(\S+)\s+(.+)$/u.exec(value);
      if (!match?.[1] || !match[2]) return "Usage: /product alias product-id alias one, alias two";
      const aliases = this.parseCommaSeparated(match[2]);
      const product = this.registry.addProductAliases(match[1], aliases);
      return `Aliases for ${product.name}: ${product.aliases.join(", ") || "none"}`;
    }

    if (action === "list") {
      if (this.registry.products.length === 0) return "No products yet. Use /product add Product Name";
      return this.registry.products
        .map((product) => {
          const aliases = product.aliases.length ? `; aliases: ${product.aliases.join(", ")}` : "";
          return `• ${product.name} (${product.id}) — ${product.repositories.length} repo(s)${aliases}`;
        })
        .join("\n");
    }

    if (action === "remove") {
      const match = /^(\S+)\s+(confirm)$/iu.exec(value);
      if (!match?.[1]) return "Usage: /product remove product-id confirm";
      const name = this.registry.removeProduct(match[1]);
      return `Removed ${name} and its repositories.`;
    }

    return [
      "Product = the app or business the repositories belong to.",
      "",
      "/product add Product Name",
      "/product alias product-id alias one, alias two",
      "/product list",
      "/product remove product-id confirm",
    ].join("\n");
  }

  private async handleRepositoryCommand(
    argumentsText: string,
    adminUserId: number,
  ): Promise<string> {
    const [rawAction = "help", ...rest] = argumentsText.split(/\s+/u);
    const action = rawAction.toLocaleLowerCase("en");
    const value = rest.join(" ").trim();

    if (action === "add") {
      const match = /^(\S+)\s+(\S+)$/u.exec(value);
      if (!match?.[1] || !match[2]) return "Usage: /repo add product-id owner/repository";
      const info = await this.qa.inspectRepository(match[2]);
      const repository = this.registry.addRepository({
        productReference: match[1],
        github: info.github,
        defaultBranch: info.defaultBranch,
        createdBy: adminUserId,
      });
      return [
        `Added ${repository.github} from branch ${repository.defaultBranch}.`,
        `ID: ${repository.id}`,
        "",
        `Optional: /repo alias ${repository.github} backend, api`,
        `Optional: /repo topics ${repository.github} booking, payment`,
      ].join("\n");
    }

    if (action === "alias" || action === "topics") {
      const match = /^(\S+)\s+(.+)$/u.exec(value);
      if (!match?.[1] || !match[2]) {
        return `Usage: /repo ${action} owner/repository phrase one, phrase two`;
      }
      const values = this.parseCommaSeparated(match[2]);
      const repository =
        action === "alias"
          ? this.registry.addRepositoryAliases(match[1], values)
          : this.registry.setRepositoryTopics(match[1], values);
      const saved = action === "alias" ? repository.aliases : repository.topics;
      return `${action === "alias" ? "Aliases" : "Topics"} for ${repository.github}: ${saved.join(", ") || "none"}`;
    }

    if (action === "component" || action === "branch") {
      const match = /^(\S+)\s+(.+)$/u.exec(value);
      if (!match?.[1] || !match[2]) {
        return `Usage: /repo ${action} owner/repository ${action === "branch" ? "branch-name" : "description"}`;
      }
      const repository =
        action === "component"
          ? this.registry.setRepositoryComponent(match[1], match[2])
          : this.registry.setRepositoryBranch(match[1], match[2]);
      return `Updated ${repository.github}: ${action === "branch" ? repository.defaultBranch : repository.component}`;
    }

    if (action === "link") {
      const match = /^(\S+)\s+(\S+)$/u.exec(value);
      if (!match?.[1] || !match[2]) return "Usage: /repo link owner/app owner/server";
      const repository = this.registry.linkRepositories(match[1], match[2]);
      return `${repository.github} will also inspect: ${repository.includeWith.join(", ")}`;
    }

    if (action === "list") {
      const product = value ? this.registry.findProduct(value) : undefined;
      if (value && !product) throw new Error(`Unknown product: ${value}`);
      const products = product ? [product] : this.registry.products;
      const lines = products.flatMap((item) => [
        `${item.name} (${item.id})`,
        ...item.repositories.map(
          (repository) =>
            `  • ${repository.github} [${repository.defaultBranch}] — ${repository.component}`,
        ),
      ]);
      return lines.length ? lines.join("\n") : "No repositories yet. Use /repo add product-id owner/repository";
    }

    if (action === "remove") {
      const match = /^(\S+)\s+(confirm)$/iu.exec(value);
      if (!match?.[1]) return "Usage: /repo remove owner/repository confirm";
      const github = this.registry.removeRepository(match[1]);
      return `Removed ${github}.`;
    }

    return [
      "Repository = one GitHub codebase inside a product.",
      "",
      "/repo add product-id owner/repository",
      "/repo alias owner/repository alias one, alias two",
      "/repo topics owner/repository topic one, topic two",
      "/repo component owner/repository description",
      "/repo branch owner/repository branch-name",
      "/repo link owner/app owner/server",
      "/repo list [product-id]",
      "/repo remove owner/repository confirm",
    ].join("\n");
  }

  private parseCommaSeparated(value: string): string[] {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  private wasInvoked(context: Context & { message: NonNullable<Context["message"]> }): boolean {
    const message = context.message;
    const username = context.me.username.toLocaleLowerCase("en");
    const structuredInvocation = message.entities?.some((entity) => {
      const value = message.text?.slice(entity.offset, entity.offset + entity.length);
      const normalized = value?.toLocaleLowerCase("en");
      return (
        (entity.type === "mention" && normalized === `@${username}`) ||
        (entity.type === "bot_command" &&
          (normalized === "/ask" || normalized === `/ask@${username}`))
      );
    });

    const text = message.text?.trimStart() ?? "";
    const plainTextInvocation =
      text.toLocaleLowerCase("en").startsWith(`@${username}`) ||
      new RegExp(`^/ask(?:@${escapeRegExp(username)})?(?:\\s|$)`, "iu").test(text);
    const repliedToBot = message.reply_to_message?.from?.id === context.me.id;
    return structuredInvocation === true || plainTextInvocation || repliedToBot;
  }

  private extractQuestion(text: string, username: string): string {
    return text
      .replace(new RegExp(`@${escapeRegExp(username)}`, "giu"), " ")
      .replace(/^\/ask\b/iu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private inheritedProductIds(
    context: Context & { message: NonNullable<Context["message"]> },
  ): readonly string[] {
    const chatId = context.chat?.id;
    if (!chatId) return [];
    const reply = context.message.reply_to_message;
    if (!reply) return [];
    const answer = this.answerContexts.get(contextKey(chatId, reply.message_id));
    return answer && answer.expiresAt >= Date.now() ? answer.productIds : [];
  }

  private async askForProduct(
    context: Context & { message: NonNullable<Context["message"]> },
    question: string,
    logContext: QuestionLogContext,
    provider: AnalystProvider,
  ): Promise<void> {
    const chatId = context.chat?.id;
    const userId = context.from?.id;
    if (!chatId || !userId) return;
    if (this.registry.products.length === 0) {
      await context.reply("No repositories are configured yet. An administrator can add one with /repo.");
      return;
    }

    const token = randomUUID().replaceAll("-", "").slice(0, 8);
    this.pendingQuestions.set(token, {
      chatId,
      userId,
      question,
      replyToMessageId: context.message.message_id,
      expiresAt: Date.now() + PENDING_QUESTION_TTL_MS,
      logContext,
      provider,
    });

    const keyboard = new InlineKeyboard();
    for (const product of this.registry.products) {
      keyboard.text(product.name, `product:${token}:${product.id}`).row();
    }

    await context.reply("Which product is this about?", {
      reply_markup: keyboard,
      reply_parameters: { message_id: context.message.message_id },
    });
  }

  private async answerQuestion(
    context: Context,
    question: string,
    route: Extract<ReturnType<typeof routeQuestion>, { kind: "selected" }>,
    logContext: QuestionLogContext,
    provider: AnalystProvider,
    replyToMessageId?: number,
  ): Promise<void> {
    const chatId = context.chat?.id;
    if (!chatId) return;

    logger.info("question.processing", {
      requestId: logContext.requestId,
      products: route.products.map((product) => product.id),
      repositories: route.repositories.map((selection) => selection.repository.github),
      provider,
    });

    const status = await context.reply(
      `🔎 ${this.providerLabel(provider)} is checking the current code…`,
      {
        ...(replyToMessageId
          ? { reply_parameters: { message_id: replyToMessageId } }
          : context.message
            ? { reply_parameters: { message_id: context.message.message_id } }
            : {}),
      },
    );

    try {
      const result = await this.qa.answer(question, route, provider);
      await context.api.editMessageText(
        chatId,
        status.message_id,
        truncateTelegramMessage(result.publicText),
      );
      this.answerContexts.set(contextKey(chatId, status.message_id), {
        productIds: result.productIds,
        technicalDetails: result.technicalDetails,
        expiresAt: Date.now() + ANSWER_CONTEXT_TTL_MS,
      });
      logger.info("question.completed", {
        requestId: logContext.requestId,
        durationMs: Date.now() - logContext.startedAt,
        repositoriesAnalyzed: route.repositories.length,
        answerCharacters: result.publicText.length,
        provider,
      });
    } catch (error) {
      logger.error("question.failed", error, {
        requestId: logContext.requestId,
        durationMs: Date.now() - logContext.startedAt,
        provider,
      });
      await context.api.editMessageText(
        chatId,
        status.message_id,
        "I could not inspect the code right now. An administrator can check RepoRoo's service logs.",
      );
    }
  }

  private isDetailsCommand(text: string, username: string): boolean {
    return new RegExp(`^/details(?:@${escapeRegExp(username)})?(?:\\s|$)`, "iu").test(text);
  }

  private async showDetails(
    context: Context & { message: NonNullable<Context["message"]> },
  ): Promise<void> {
    const userId = context.from?.id;
    const chatId = context.chat?.id;
    if (!userId || !chatId) return;

    if (!this.config.adminUserIds.has(userId)) {
      await context.reply("Technical details are available to RepoRoo administrators.");
      return;
    }

    const reply = context.message.reply_to_message;
    const answer = reply
      ? this.answerContexts.get(contextKey(chatId, reply.message_id))
      : undefined;
    const details = answer && answer.expiresAt >= Date.now() ? answer.technicalDetails : undefined;

    await context.reply(
      details
        ? truncateTelegramMessage(details)
        : "Reply to one of RepoRoo's answers with /details.",
      { reply_parameters: { message_id: context.message.message_id } },
    );
  }

  private consumeRateLimit(userId: number): boolean {
    const cutoff = Date.now() - 60_000;
    const recent = (this.requestTimes.get(userId) ?? []).filter((time) => time >= cutoff);
    if (recent.length >= this.config.rateLimitPerMinute) {
      this.requestTimes.set(userId, recent);
      return false;
    }

    recent.push(Date.now());
    this.requestTimes.set(userId, recent);
    return true;
  }

  private pruneExpiredState(now = Date.now()): void {
    if (now - this.lastStatePruneAt < STATE_PRUNE_INTERVAL_MS) return;
    this.lastStatePruneAt = now;

    for (const [token, pending] of this.pendingQuestions) {
      if (pending.expiresAt < now) this.pendingQuestions.delete(token);
    }
    for (const [key, answer] of this.answerContexts) {
      if (answer.expiresAt < now) this.answerContexts.delete(key);
    }
    const requestCutoff = now - 60_000;
    for (const [userId, times] of this.requestTimes) {
      const recent = times.filter((time) => time >= requestCutoff);
      if (recent.length > 0) this.requestTimes.set(userId, recent);
      else this.requestTimes.delete(userId);
    }
  }
}
