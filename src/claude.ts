import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  query,
  type CanUseTool,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import {
  analysisJsonSchema,
  analysisSchema,
  publicResponseJsonSchema,
  publicResponseSchema,
  repositoryAnalysisPrompt,
  synthesisPrompt,
  type PublicResponse,
  type RepositoryAnalyst,
  type RepositoryFinding,
} from "./analyst.js";
import type { RepositorySnapshot } from "./github.js";
import type { ProductDefinition, RepositoryDefinition } from "./registry.js";

const READ_TOOLS = ["Read", "Glob", "Grep"];
const MAX_AGENT_TURNS = 30;

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function containsParentTraversal(value: string): boolean {
  return value.includes("..");
}

function repositoryPermissions(repositoryRoot: string): CanUseTool {
  return async (toolName, input) => {
    if (toolName === "Read") {
      const requested = input.file_path;
      if (typeof requested !== "string" || !requested.trim()) {
        return { behavior: "deny", message: "A repository file path is required." };
      }

      try {
        const root = await realpath(repositoryRoot);
        const candidate = await realpath(resolve(root, requested));
        if (!isInside(root, candidate)) {
          return { behavior: "deny", message: "Only files inside this repository may be read." };
        }
        return {
          behavior: "allow",
          updatedInput: { ...input, file_path: candidate },
        };
      } catch {
        return { behavior: "deny", message: "The requested repository file does not exist." };
      }
    }

    if (toolName === "Glob") {
      const pattern = input.pattern;
      if (typeof pattern !== "string" || isAbsolute(pattern) || containsParentTraversal(pattern)) {
        return { behavior: "deny", message: "Glob patterns must stay inside this repository." };
      }
      return {
        behavior: "allow",
        updatedInput: { ...input, path: repositoryRoot },
      };
    }

    if (toolName === "Grep") {
      return {
        behavior: "allow",
        updatedInput: { ...input, path: repositoryRoot },
      };
    }

    return { behavior: "deny", message: "RepoRoo permits read-only repository tools only." };
  };
}

function resultError(result: SDKResultMessage): Error {
  if (result.subtype === "success") {
    return new Error("Claude returned no structured result");
  }
  return new Error(`Claude analysis failed (${result.subtype}): ${result.errors.join("; ")}`);
}

export class ClaudeAnalyst implements RepositoryAnalyst {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async analyzeRepository(input: {
    question: string;
    product: ProductDefinition;
    repository: RepositoryDefinition;
    snapshot: RepositorySnapshot;
  }): Promise<RepositoryFinding> {
    const parsed = await this.runStructured(
      repositoryAnalysisPrompt(input),
      input.snapshot.directory,
      analysisJsonSchema,
      analysisSchema,
      true,
    );

    return {
      ...parsed,
      productId: input.product.id,
      productName: input.product.name,
      repositoryId: input.repository.id,
      repository: input.repository.github,
      component: input.repository.component,
      commit: input.snapshot.commit,
    };
  }

  async synthesize(
    question: string,
    findings: readonly RepositoryFinding[],
    workingDirectory: string,
  ): Promise<PublicResponse> {
    if (findings.length === 1) {
      const [finding] = findings;
      if (!finding) throw new Error("Expected one repository finding");
      return {
        publicAnswer: finding.publicAnswer,
        importantNotes: finding.importantNotes,
        confidence: finding.confidence,
      };
    }

    return this.runStructured(
      synthesisPrompt(question, findings),
      workingDirectory,
      publicResponseJsonSchema,
      publicResponseSchema,
      false,
    );
  }

  private async runStructured<T>(
    prompt: string,
    workingDirectory: string,
    outputSchema: Record<string, unknown>,
    parser: z.ZodType<T>,
    allowRepositoryReads: boolean,
  ): Promise<T> {
    let result: SDKResultMessage | undefined;
    const options = {
      cwd: workingDirectory,
      model: this.model,
      maxTurns: MAX_AGENT_TURNS,
      settingSources: [],
      strictMcpConfig: true,
      tools: allowRepositoryReads ? READ_TOOLS : [],
      permissionMode: "default" as const,
      ...(allowRepositoryReads
        ? { canUseTool: repositoryPermissions(workingDirectory) }
        : {}),
      outputFormat: {
        type: "json_schema" as const,
        schema: outputSchema,
      },
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: this.apiKey,
        CLAUDE_AGENT_SDK_CLIENT_APP: "reporoo/0.1.0",
      },
    };

    for await (const message of query({ prompt, options })) {
      if (message.type === "result") result = message;
    }

    if (!result || result.subtype !== "success" || result.is_error || !result.structured_output) {
      throw result ? resultError(result) : new Error("Claude analysis ended without a result");
    }
    return parser.parse(result.structured_output);
  }
}
