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

// Stable question stem recorded on every catch recall — the feedback path matches QAs by it.
export const CATCH_QUESTION = "Does this pull request re-propose a past decision?";

/** Extract a decision from one issue/PR thread and remember() it into the dataset. */
export async function ingestItem(
  inst: Installation,
  cfg: TenantConfig,
  creds: TenantCredentials,
  it: RepoItem,
  repo: string,
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
    repo,
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
    await db.markSuperseded(inst.installationId, repo, d.supersedesRefs, decisionId);
  }
}

/** Given PR text, decide whether to comment and what to say (grounding + score gates + judgment). */
export async function evaluatePr(
  inst: Installation,
  cfg: TenantConfig,
  creds: TenantCredentials,
  prText: string,
  repo: string,
  sessionId?: string,
): Promise<Judgment> {
  const records = await db.getDecisionRecords(inst.installationId, repo);
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
    const r = byData.get(c.documentId) ?? byId.get(c.documentName) ?? byId.get(c.documentName.toUpperCase());
    // Bounded recency penalty: only nudges fuzzy matches near the cutoff (max +0.015 distance).
    const penalty = r ? (1 - recencyWeight(r.decidedAt)) * 0.1 : 0;
    if (c.score + penalty > cfg.scoreCutoff) continue;
    if (r) candidates.set(r.decisionId, r);
  }

  if (candidates.size === 0) return { matches: false, decisionId: null, comment: "" };

  // Cited recall (chain-of-thought) from the knowledge graph as context for the judgment.
  // With a sessionId it goes through /recall, recording a QA entry so maintainer feedback can reweight it.
  const query = `${CATCH_QUESTION}\n${prText}`;
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

// Gentle recency preference. Cognee's retriever has no decay, so we keep it here — but BOUNDED
// (never below FLOOR) so an old-but-exactly-re-proposed decision is still caught. Returns [FLOOR, 1].
const DECAY_FLOOR = 0.85;
const DECAY_HALFLIFE_DAYS = 540; // ~18 months
export function recencyWeight(decidedAt: string, nowMs: number = Date.now()): number {
  const t = Date.parse(decidedAt);
  if (Number.isNaN(t)) return 1;
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  const w = Math.pow(0.5, ageDays / DECAY_HALFLIFE_DAYS);
  return DECAY_FLOOR + (1 - DECAY_FLOOR) * w;
}

// Heuristic: does this question ask about a time window? (routes `ask` to TEMPORAL search).
export function isTemporalQuery(q: string): boolean {
  return /\b(q[1-4]|quarter|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|20\d\d|last (week|month|year|quarter)|since|before|after|between|recently|when did)\b/i.test(
    q,
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

// --- coding rules: CODING_RULES enforcement (REST-native) + seeding via node_set ---

const RULES_NODESET = "coding_agent_rules";

/** Mine rules from freeform text and seed them into the graph under the coding-rules nodeset. */
export async function seedRules(
  inst: Installation,
  cfg: TenantConfig,
  creds: TenantCredentials,
  text: string,
): Promise<string[]> {
  const rules = await llm.extractRules(cfg.llmProvider, text);
  if (rules.length === 0) return [];
  await cognee.remember(cog, creds, {
    datasetName: inst.datasetName,
    filename: "coding-rules.txt",
    content: rules.map((r) => `- ${r}`).join("\n"),
    nodeSet: RULES_NODESET,
  });
  return rules;
}

/** List the repo's coding rules (deterministic CODING_RULES search — no LLM). */
export async function listRules(inst: Installation, creds: TenantCredentials): Promise<string[]> {
  return cognee.searchCodingRules(cog, creds, { datasetName: inst.datasetName, nodeset: RULES_NODESET });
}

/** Which seeded rules does this PR text plausibly touch (grounding gate; advisory, non-blocking). */
export async function matchRules(
  inst: Installation,
  cfg: TenantConfig,
  creds: TenantCredentials,
  prText: string,
): Promise<string[]> {
  const rules = await listRules(inst, creds);
  return rules.filter((r) => grounded(prText, r, Math.max(2, cfg.confidenceThreshold)));
}

/** Cited recall over the tenant's decision graph (for `@codeguard recall|why`).
 *  Date-scoped questions ("what did we reject in Q1?") route to the TEMPORAL retriever. */
export async function ask(inst: Installation, creds: TenantCredentials, query: string): Promise<string> {
  const res = await cognee.search(cog, creds, {
    datasetName: inst.datasetName,
    query,
    searchType: isTemporalQuery(query) ? "TEMPORAL" : "GRAPH_COMPLETION",
    includeReferences: true,
  });
  return firstAnswer(res);
}

/** Mint a NEW accepted decision that SUPERSEDES a cited rejection (the `@codeguard override` loop). */
export async function overrideDecision(
  inst: Installation,
  creds: TenantCredentials,
  a: { repo: string; citedRef: string; reason: string; by: string; number: number; sourceUrl: string },
): Promise<string> {
  const newId = `OVERRIDE-${a.number}-${Math.random().toString(36).slice(2, 8)}`;
  const cited = await db.getDecisionRecord(inst.installationId, a.repo, a.citedRef);
  const doc = `Decision ${newId} (ACCEPTED): Override of ${a.citedRef} by @${a.by}. ${a.reason} Source: ${a.sourceUrl}`;
  const res = await cognee.remember(cog, creds, { datasetName: inst.datasetName, filename: `${newId}.txt`, content: doc });
  await db.upsertDecisionRecord({
    decisionId: newId,
    installationId: inst.installationId,
    repo: a.repo,
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
  await db.setSuperseded(inst.installationId, a.repo, a.citedRef, newId);
  return newId;
}

function dataId(res: unknown): string | undefined {
  const r = res as { items?: Array<{ id?: string }> } | undefined;
  return r?.items?.[0]?.id;
}
