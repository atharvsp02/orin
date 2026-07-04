// The three platform-neutral verbs every adapter (GitHub, MCP, Slack, Linear) maps onto.
// Thin wrappers over the decision core in pipeline.ts, keyed by a resolved Tenant.
import * as pipeline from "./pipeline.js";
import type { Tenant } from "./tenant.js";
import type { Judgment } from "./llm.js";
import type { DecisionSource } from "./types.js";

/** Cited recall over the tenant's decision memory (→ ask_decision / /why).
 *  Recall is installation-wide by construction — the Cognee dataset is per-installation, not per-repo. */
export async function ask(t: Tenant, query: string): Promise<string> {
  return pipeline.ask(t.inst, t.creds, query);
}

/** Does this text re-propose a rejected decision? No writes (→ check_rejected).
 *  Pass `repo` to scope the deterministic pass to one repo (a repo-scoped key must not enforce
 *  against another repo's decisions); omit for installation-wide. */
export async function warn(t: Tenant, text: string, repo?: string): Promise<Judgment> {
  return pipeline.evaluatePr(t.inst, t.cfg, t.creds, text, repo);
}

export interface NeutralItem {
  kind: DecisionSource; // "pr" | "issue" | "doc"
  number: number;
  title: string;
  body: string;
  url: string;
  comments?: string[];
  closedAt?: string;
  repo?: string; // decision scope; adapters without a repo use ""
}

/** Record a decision from a platform-neutral item (→ record_decision / reaction-to-ingest). */
export async function ingest(t: Tenant, item: NeutralItem): Promise<void> {
  await pipeline.ingestItem(
    t.inst,
    t.cfg,
    t.creds,
    {
      kind: item.kind,
      number: item.number,
      title: item.title,
      body: item.body,
      url: item.url,
      state: "closed",
      stateReason: null,
      labels: [],
      comments: item.comments ?? [],
      closedAt: item.closedAt ?? null,
    },
    item.repo ?? "",
  );
}
