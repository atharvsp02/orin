export type DecisionOutcome = "accepted" | "rejected" | "reverted";
export type DecisionSource = "pr" | "issue" | "doc";

export interface Installation {
  installationId: number;
  githubAccount: string;
  datasetName: string;
  cogneeApiKey: string; // encrypted at rest
  createdAt: string;
}

export interface TenantConfig {
  installationId: number;
  tone: "friendly" | "terse";
  watchPaths: string[];
  confidenceThreshold: number; // grounding-gate term overlap
  scoreCutoff: number; // CHUNKS cosine-distance cutoff (lower = closer)
  autoComment: boolean;
  customInstructions: string;
  llmProvider: "google" | "openai" | "deepseek" | "openrouter";
}

export interface DecisionRecord {
  decisionId: string;
  installationId: number;
  sourceType: DecisionSource;
  sourceUrl: string;
  title: string;
  outcome: DecisionOutcome;
  reasoningText: string;
  decidedAt: string;
  terms: string[]; // deps / paths / labels for the deterministic pass
  supersededBy?: string;
  cogneeDataId?: string;
  createdAt: string;
}
