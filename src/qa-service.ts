import type {
  AnalystProvider,
  RepositoryAnalyst,
  RepositoryFinding,
} from "./analyst.js";
import { GitHubSnapshots } from "./github.js";
import type { GitHubRepositoryInfo } from "./github.js";
import type { RouteResult } from "./router.js";

export type QuestionAnswer = {
  publicText: string;
  technicalDetails: string;
  productIds: readonly string[];
};

function publicText(input: {
  answer: string;
  notes: readonly string[];
  confidence: "high" | "medium" | "low";
  productNames: readonly string[];
}): string {
  const sections = [input.answer.trim()];

  if (input.notes.length > 0) {
    sections.push(`Important:\n${input.notes.map((note) => `• ${note}`).join("\n")}`);
  }

  if (input.confidence === "low") {
    sections.push("I could not fully confirm this from the current code.");
  }

  sections.push(`Based on the current ${input.productNames.join(" and ")} code.`);
  return sections.join("\n\n");
}

function technicalDetails(findings: readonly RepositoryFinding[]): string {
  const blocks = findings.map((finding) => {
    const evidence = finding.evidence.length
      ? finding.evidence
          .map((item) => {
            const location = item.line ? `${item.file}:${item.line}` : item.file;
            return `• ${location} — ${item.explanation}`;
          })
          .join("\n")
      : "• No direct file evidence was found in this repository.";

    return `${finding.repository} (${finding.commit.slice(0, 12)})\n${evidence}`;
  });

  return blocks.join("\n\n");
}

export class QuestionAnswerService {
  constructor(
    private readonly snapshots: GitHubSnapshots,
    private readonly analysts: ReadonlyMap<AnalystProvider, RepositoryAnalyst>,
    private readonly maxRepositoriesPerQuestion: number,
  ) {}

  get availableProviders(): readonly AnalystProvider[] {
    return [...this.analysts.keys()];
  }

  hasProvider(provider: AnalystProvider): boolean {
    return this.analysts.has(provider);
  }

  async assertReady(): Promise<void> {
    await this.snapshots.assertReady();
  }

  async inspectRepository(github: string): Promise<GitHubRepositoryInfo> {
    return this.snapshots.inspectRepository(github);
  }

  async answer(
    question: string,
    route: Extract<RouteResult, { kind: "selected" }>,
    provider: AnalystProvider,
  ): Promise<QuestionAnswer> {
    const analyst = this.analysts.get(provider);
    if (!analyst) throw new Error(`Analysis provider is not configured: ${provider}`);

    if (route.repositories.length > this.maxRepositoriesPerQuestion) {
      throw new Error(
        `This question selected ${route.repositories.length} repositories; the configured limit is ${this.maxRepositoriesPerQuestion}.`,
      );
    }

    const findings: RepositoryFinding[] = [];
    let synthesisDirectory: string | undefined;

    for (const selection of route.repositories) {
      const snapshot = await this.snapshots.sync(
        selection.product.id,
        selection.repository,
      );
      synthesisDirectory ??= snapshot.directory;
      findings.push(
        await analyst.analyzeRepository({
          question,
          product: selection.product,
          repository: selection.repository,
          snapshot,
        }),
      );
    }

    if (!synthesisDirectory || findings.length === 0) {
      throw new Error("No repositories were selected for this question");
    }

    const response = await analyst.synthesize(question, findings, synthesisDirectory);
    const productNames = [...new Set(route.products.map((product) => product.name))];

    return {
      publicText: publicText({
        answer: response.publicAnswer,
        notes: response.importantNotes,
        confidence: response.confidence,
        productNames,
      }),
      technicalDetails: technicalDetails(findings),
      productIds: route.products.map((product) => product.id),
    };
  }
}
