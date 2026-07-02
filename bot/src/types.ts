export type DecisionOutcome = "accepted" | "rejected" | "reverted";
export type DecisionSource = "pr" | "issue" | "doc";
export type DeliveryMode = "check" | "review" | "comment";

export interface PrFile {
  path: string;
  status: string;
  patch?: string; // unified diff; absent for binary/too-large
  additions: number;
  deletions: number;
}

export interface PrSnapshot {
  number: number;
  title: string;
  body: string;
  url: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  draft: boolean;
  files: PrFile[];
}

export interface Anchor {
  path: string;
  side: "RIGHT" | "LEFT";
  line: number; // last line of the range (head-file line for RIGHT)
  startLine?: number; // first line (multi-line only)
  level: "notice" | "warning" | "failure";
  message: string;
  suggestion?: string; // raw replacement text → fenced ```suggestion```
}

export interface Finding {
  decisionId: string;
  title: string;
  outcome: string;
  sourceUrl: string;
  summaryMd: string; // the drafted comment body
  anchors: Anchor[];
}

export interface DeliveryDecision {
  blocking: boolean; // → check conclusion failure vs neutral
  findings: Finding[]; // empty ⇒ clean ⇒ conclusion success
}

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
  deliveryMode: DeliveryMode; // how a finding is delivered on GitHub
  blockOnRepropose: boolean; // fail the check (block merge) vs. advisory
}

export interface DecisionRecord {
  decisionId: string;
  installationId: number;
  repo: string; // repo-scoped: decision ids (PR-42) collide across repos in one installation
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
