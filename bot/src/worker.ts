import PgBoss from "pg-boss";
import { config } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import * as llm from "./llm.js";
import * as cognee from "./cognee.js";
import type { TenantCredentials } from "./cognee.js";

export const QUEUE = { ingest: "ingest", catch: "catch" } as const;

const cog = { baseUrl: config.cogneeBaseUrl };

export interface IngestJob {
  installationId: number;
  repo: string;
  limit?: number;
}
export interface CatchJob {
  installationId: number;
  repo: string;
  prNumber: number;
}

export async function startQueue(): Promise<PgBoss> {
  const boss = new PgBoss(config.databaseUrl);
  await boss.start();
  await boss.createQueue(QUEUE.ingest);
  await boss.createQueue(QUEUE.catch);
  await boss.work<IngestJob>(QUEUE.ingest, ingestWorker);
  await boss.work<CatchJob>(QUEUE.catch, catchWorker);
  return boss;
}

// Backfill / doc ingest -> extract a decision record -> remember() into the dataset.
async function ingestWorker(jobs: PgBoss.Job<IngestJob>[]): Promise<void> {
  for (const { data } of jobs) {
    const inst = await db.getInstallation(data.installationId);
    if (!inst) {
      console.warn("ingest: unknown installation", data.installationId);
      continue;
    }
    const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
    const cfg = await db.getTenantConfig(data.installationId);
    const items = await gh.fetchClosedItems(data.installationId, data.repo, data.limit ?? 50);

    for (const it of items) {
      const thread = `${it.title}\n\n${it.body}\n\n${it.comments.join("\n---\n")}`;
      const d = await llm.extractDecision(cfg.llmProvider, thread);
      if (!d.isDecision) continue;

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
        installationId: data.installationId,
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
    }
    console.log(`ingest done: ${data.repo} (${items.length} items scanned)`);
  }
}

// PR opened -> precision pipeline (see docs/specs) -> one cited comment, or stay silent.
async function catchWorker(jobs: PgBoss.Job<CatchJob>[]): Promise<void> {
  for (const { data } of jobs) {
    if (await db.alreadyCommented(data.installationId, data.repo, data.prNumber)) continue;
    const inst = await db.getInstallation(data.installationId);
    if (!inst) continue;

    const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
    const cfg = await db.getTenantConfig(data.installationId);
    const pr = await gh.fetchPr(data.installationId, data.repo, data.prNumber);
    const prText = `${pr.title}\n\n${pr.body}\n\nFiles: ${pr.files.join(", ")}`;

    // Candidate pass: rejected, not-superseded records that share enough terms (grounding gate).
    const records = await db.getDecisionRecords(data.installationId);
    const candidates = records
      .filter((r) => r.outcome === "rejected" && !r.supersededBy)
      .filter((r) => grounded(prText, `${r.reasoningText} ${r.terms.join(" ")}`, cfg.confidenceThreshold));
    if (candidates.length === 0) continue; // refuse on weak/empty evidence — stay silent

    // Memory pass: cited recall from the Cognee knowledge graph.
    const recall = await cognee.search(cog, creds, {
      datasetName: inst.datasetName,
      query: `Does this pull request re-propose a past decision?\n${prText}`,
      searchType: "GRAPH_COMPLETION",
      includeReferences: true,
    });

    const judgment = await llm.judgePr(
      cfg.llmProvider,
      prText,
      candidates.map((c) => ({
        decisionId: c.decisionId,
        title: c.title,
        outcome: c.outcome,
        reasoning: c.reasoningText,
        url: c.sourceUrl,
      })),
      firstAnswer(recall),
      cfg.customInstructions,
    );

    if (judgment.matches && judgment.decisionId && judgment.comment) {
      if (cfg.autoComment) await gh.postComment(data.installationId, data.repo, data.prNumber, judgment.comment);
      await db.recordComment(data.installationId, data.repo, data.prNumber, judgment.decisionId);
    }
  }
}

// Grounding gate: require >= threshold shared significant terms (the false-positive guard).
function grounded(a: string, b: string, threshold: number): boolean {
  const sig = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
  const ta = sig(a);
  const tb = sig(b);
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap >= threshold;
}

function firstAnswer(res: unknown): string {
  const arr = res as Array<{ search_result?: unknown }> | undefined;
  const first = Array.isArray(arr) ? arr[0]?.search_result : undefined;
  if (Array.isArray(first)) return String(first[0] ?? "");
  return typeof first === "string" ? first : "";
}

function dataId(res: unknown): string | undefined {
  const r = res as { items?: Array<{ id?: string }> } | undefined;
  return r?.items?.[0]?.id;
}
