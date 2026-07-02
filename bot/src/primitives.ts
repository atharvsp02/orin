// The three platform-neutral verbs every adapter (GitHub, MCP, Slack, Linear) maps onto.
// Thin wrappers over the decision core in pipeline.ts, keyed by a resolved Tenant.
import * as pipeline from "./pipeline.js";
import type { Tenant } from "./tenant.js";
import type { Judgment } from "./llm.js";
import type { DecisionSource } from "./types.js";

/** Cited recall over the tenant's decision memory (→ ask_decision / /why). */
export async function ask(t: Tenant, query: string): Promise<string> {
  return pipeline.ask(t.inst, t.creds, query);
}

/** Does this text re-propose a rejected decision? Installation-wide, no writes (→ check_rejected). */
export async function warn(t: Tenant, text: string): Promise<Judgment> {
  return pipeline.evaluatePr(t.inst, t.cfg, t.creds, text);
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
