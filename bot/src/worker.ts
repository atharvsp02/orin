import PgBoss from "pg-boss";
import { config } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { ingestItem, evaluatePr } from "./pipeline.js";
import { resolveDelivery, buildDecision } from "./delivery.js";
import type { DeliveryRefs } from "./delivery.js";
import type { TenantCredentials } from "./cognee.js";
import type { DeliveryMode } from "./types.js";

export const QUEUE = { ingest: "ingest", catch: "catch" } as const;

export interface IngestJob {
  installationId: number;
  repo: string;
  number?: number; // single-item (live) ingest; omit for a full backfill
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

async function ingestWorker(jobs: PgBoss.Job<IngestJob>[]): Promise<void> {
  for (const { data } of jobs) {
    const inst = await db.getInstallation(data.installationId);
    if (!inst) {
      console.warn("ingest: unknown installation", data.installationId);
      continue;
    }
    const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
    const cfg = await db.getTenantConfig(data.installationId);

    if (data.number != null) {
      const it = await gh.fetchItem(data.installationId, data.repo, data.number);
      await ingestItem(inst, cfg, creds, it);
      continue;
    }
    const items = await gh.fetchClosedItems(data.installationId, data.repo, data.limit ?? 50);
    for (const it of items) await ingestItem(inst, cfg, creds, it);
    console.log(`ingest done: ${data.repo} (${items.length} items scanned)`);
  }
}

async function catchWorker(jobs: PgBoss.Job<CatchJob>[]): Promise<void> {
  for (const { data } of jobs) {
    const inst = await db.getInstallation(data.installationId);
    if (!inst) continue;
    const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
    const cfg = await db.getTenantConfig(data.installationId);
    const pr = await gh.fetchPr(data.installationId, data.repo, data.prNumber);

    const [owner, repo] = data.repo.split("/");
    const octokit = await gh.installationOctokit(data.installationId);
    const ctx = {
      octokit,
      owner,
      repo,
      number: data.prNumber,
      headSha: pr.headSha,
      externalId: `${data.installationId}:${data.repo}#${data.prNumber}`,
    };
    const delivery = resolveDelivery(cfg.deliveryMode);

    // Idempotency per head_sha: synchronize re-runs reuse the same check/review/comment.
    const prior = await db.getDelivery(data.installationId, data.repo, data.prNumber, pr.headSha);
    let refs: DeliveryRefs | null = prior
      ? {
          mode: prior.mode as DeliveryMode,
          checkRunId: prior.checkRunId ?? undefined,
          reviewId: prior.reviewId ?? undefined,
          commentId: prior.commentId ?? undefined,
        }
      : null;
    if (cfg.autoComment && !refs) refs = await delivery.open(ctx); // show the check in_progress while we work

    const prText = `${pr.title}\n\n${pr.body}\n\nFiles: ${pr.files.map((f) => f.path).join(", ")}`;
    const sessionId = `codeguard-pr-${data.installationId}-${data.prNumber}`;
    const judgment = await evaluatePr(inst, cfg, creds, prText, sessionId);
    const decision = await buildDecision(inst, cfg, pr, judgment);

    if (cfg.autoComment) {
      refs = decision.findings.length ? await delivery.publish(ctx, refs, decision) : await delivery.clear(ctx, refs);
    }

    await db.upsertDelivery({
      installationId: data.installationId,
      repo: data.repo,
      prNumber: data.prNumber,
      headSha: pr.headSha,
      mode: refs?.mode ?? null,
      checkRunId: refs?.checkRunId ?? null,
      reviewId: refs?.reviewId ?? null,
      commentId: refs?.commentId ?? null,
      decisionId: judgment.decisionId,
      sessionId,
      state: decision.findings.length ? "posted" : "clear",
    });
  }
}
