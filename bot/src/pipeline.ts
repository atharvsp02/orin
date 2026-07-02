import { config } from "./config.js";
import * as db from "./db.js";
import * as llm from "./llm.js";
import * as cognee from "./cognee.js";
import type { TenantCredentials } from "./cognee.js";
import type { Judgment } from "./llm.js";
import type { RepoItem } from "./github.js";
import type { DecisionRecord, Installation, TenantConfig } from "./types.js";

// Decision core — no GitHub I/O, so it is unit-testable in isolation.
const cog = { baseUrl: config.cogneeBaseUrl };

/** Extract a decision from one issue/PR thread and remember() it into the dataset. */
export async function ingestItem(
  inst: Installation,
  cfg: TenantConfig,
  creds: TenantCredentials,
  it: RepoItem,
): Promise<void> {
  const thread = `${it.title}\n\n${it.body}\n\n${it.comments.join("\n---\n")}`;
  const d = await llm.extractDecision(cfg.llmProvider, thread);
  if (!d.isDecision) return;

  const decisionId = `${it.kind.toUpperCase()}-${it.number}`;
  const doc =
    `Decision ${decisionId} (${it.closedAt ?? ""}, ${d.outcome.toUpperCase()}): ` +
    `${d.title}. ${d.reasoning} Source: ${it.url}`;
  const res = await cognee.remember(cog, creds, {
    datasetName: inst.datasetName,
    filename: `${decisionId}.txt`,
    content: doc,
  });
  await db.upsertDecisionRecord({
    decisionId,
    installationId: inst.installationId,
    sourceType: it.kind,
    sourceUrl: it.url,
    title: d.title,
    outcome: d.outcome,
    reasoningText: d.reasoning,
    decidedAt: it.closedAt ?? "",
    terms: d.terms,
    cogneeDataId: dataId(res),
    createdAt: "",
  });
  if (d.supersedesRefs.length) {
    await db.markSuperseded(inst.installationId, d.supersedesRefs, decisionId);
  }
}

/** Given PR text, decide whether to comment and what to say (grounding + score gates + judgment). */
export async function evaluatePr(
  inst: Installation,
  cfg: TenantConfig,
  creds: TenantCredentials,
  prText: string,
  sessionId?: string,
): Promise<Judgment> {
  const records = await db.getDecisionRecords(inst.installationId);
  const active = records.filter((r) => r.outcome === "rejected" && !r.supersededBy);

  const candidates = new Map<string, DecisionRecord>();

  // Deterministic pass: shared significant terms above the grounding threshold.
  for (const r of active) {
    if (grounded(prText, `${r.reasoningText} ${r.terms.join(" ")}`, cfg.confidenceThreshold)) {
      candidates.set(r.decisionId, r);
    }
  }

  // Semantic pass: CHUNKS relevance scores, mapped back to records, gated by scoreCutoff.
  const byId = new Map(active.map((r) => [r.decisionId, r]));
  const byData = new Map(active.filter((r) => r.cogneeDataId).map((r) => [r.cogneeDataId as string, r]));
  const chunks = await cognee.searchChunksScored(cog, creds, { datasetName: inst.datasetName, query: prText, topK: 5 });
  for (const c of chunks) {
    if (c.score > cfg.scoreCutoff) continue;
    const r = byData.get(c.documentId) ?? byId.get(c.documentName) ?? byId.get(c.documentName.toUpperCase());
    if (r) candidates.set(r.decisionId, r);
  }

  if (candidates.size === 0) return { matches: false, decisionId: null, comment: "" };

  // Cited recall (chain-of-thought) from the knowledge graph as context for the judgment.
  // With a sessionId it goes through /recall, recording a QA entry so maintainer feedback can reweight it.
  const query = `Does this pull request re-propose a past decision?\n${prText}`;
  const recall = sessionId
    ? await cognee.recallWithSession(cog, creds, {
        datasetName: inst.datasetName,
        query,
        sessionId,
        searchType: "GRAPH_COMPLETION_COT",
        includeReferences: true,
      })
    : await cognee.search(cog, creds, {
        datasetName: inst.datasetName,
        query,
        searchType: "GRAPH_COMPLETION_COT",
        includeReferences: true,
      });

  return llm.judgePr(
    cfg.llmProvider,
    prText,
    [...candidates.values()].map((c) => ({
      decisionId: c.decisionId,
      title: c.title,
      outcome: c.outcome,
      reasoning: c.reasoningText,
      url: c.sourceUrl,
    })),
    firstAnswer(recall),
    cfg.customInstructions,
  );
}

// Grounding gate: require >= threshold shared significant terms (the false-positive guard).
export function grounded(a: string, b: string, threshold: number): boolean {
  const sig = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
  const ta = sig(a);
  const tb = sig(b);
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap >= threshold;
}

function firstAnswer(res: unknown): string {
  const arr = res as Array<{ search_result?: unknown; text?: unknown }> | undefined;
  const o = Array.isArray(arr) ? arr[0] : undefined;
  if (!o) return "";
  if (typeof o.text === "string") return o.text; // /recall shape
  const sr = o.search_result; // /search shape
  if (Array.isArray(sr)) return String(sr[0] ?? "");
  return typeof sr === "string" ? sr : "";
}

// --- lifecycle: maintainer feedback → reweight the exact decision nodes → improve ---

/** Attach a maintainer 👍/👎 to the recall QA that produced a verdict on this PR. */
export async function submitFeedback(
  creds: TenantCredentials,
  opts: { datasetName: string; sessionId: string; question: string; score: 1 | 2 | 3 | 4 | 5 },
): Promise<void> {
  const qas = await cognee.getSessionQAs(cog, creds, opts.sessionId);
  const needle = opts.question.slice(0, 40);
  const qa = qas.find((q) => q.question.includes(needle)) ?? qas[qas.length - 1];
  if (!qa?.qaId) return;
  await cognee.addFeedback(cog, creds, {
    datasetName: opts.datasetName,
    sessionId: opts.sessionId,
    qaId: qa.qaId,
    score: opts.score,
  });
}

/** Apply accumulated feedback for a tenant's sessions (run on a schedule or after a 👍/👎). */
export async function improveTenant(creds: TenantCredentials, datasetName: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await cognee.improve(cog, creds, { datasetName, sessionIds });
}

/** Cited recall over the tenant's decision graph (for `@codeguard recall|why`). */
export async function ask(inst: Installation, creds: TenantCredentials, query: string): Promise<string> {
  const res = await cognee.search(cog, creds, {
    datasetName: inst.datasetName,
    query,
    searchType: "GRAPH_COMPLETION",
    includeReferences: true,
  });
  return firstAnswer(res);
}

/** Mint a NEW accepted decision that SUPERSEDES a cited rejection (the `@codeguard override` loop). */
export async function overrideDecision(
  inst: Installation,
  creds: TenantCredentials,
  a: { citedRef: string; reason: string; by: string; number: number; sourceUrl: string },
): Promise<string> {
  const newId = `OVERRIDE-${a.number}-${Math.random().toString(36).slice(2, 8)}`;
  const cited = await db.getDecisionRecord(inst.installationId, a.citedRef);
  const doc = `Decision ${newId} (ACCEPTED): Override of ${a.citedRef} by @${a.by}. ${a.reason} Source: ${a.sourceUrl}`;
  const res = await cognee.remember(cog, creds, { datasetName: inst.datasetName, filename: `${newId}.txt`, content: doc });
  await db.upsertDecisionRecord({
    decisionId: newId,
    installationId: inst.installationId,
    sourceType: "pr",
    sourceUrl: a.sourceUrl,
    title: `Override of ${cited?.title ?? a.citedRef}`,
    outcome: "accepted",
    reasoningText: a.reason,
    decidedAt: new Date().toISOString(),
    terms: cited?.terms ?? [],
    cogneeDataId: dataId(res),
    createdAt: "",
  });
  // Exact supersession — the caller must have already authorized this citedRef against the thread.
  await db.setSuperseded(inst.installationId, a.citedRef, newId);
  return newId;
}

function dataId(res: unknown): string | undefined {
  const r = res as { items?: Array<{ id?: string }> } | undefined;
  return r?.items?.[0]?.id;
}
