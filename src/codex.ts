import { Codex } from "@openai/codex-sdk";
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

export class CodexAnalyst implements RepositoryAnalyst {
  private readonly codex = new Codex();

  constructor(private readonly model: string | undefined) { }

  async analyzeRepository(input: {
    question: string;
    product: ProductDefinition;
    repository: RepositoryDefinition;
    snapshot: RepositorySnapshot;
  }): Promise<RepositoryFinding> {
    const thread = this.codex.startThread({
      workingDirectory: input.snapshot.directory,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      ...(this.model ? { model: this.model } : {}),
    });

    const prompt = repositoryAnalysisPrompt(input);

    const turn = await thread.run(prompt, { outputSchema: analysisJsonSchema });
    const parsed = analysisSchema.parse(JSON.parse(turn.finalResponse));

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

    const thread = this.codex.startThread({
      workingDirectory,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      ...(this.model ? { model: this.model } : {}),
    });

    const prompt = synthesisPrompt(question, findings);

    const turn = await thread.run(prompt, { outputSchema: publicResponseJsonSchema });
    return publicResponseSchema.parse(JSON.parse(turn.finalResponse));
  }
}
