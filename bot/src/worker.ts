import PgBoss from "pg-boss";
import { config } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { ingestItem, evaluatePr } from "./pipeline.js";
import { resolveDelivery, buildDecision } from "./delivery.js";
import { handleCommand } from "./commands.js";
import { QUEUE } from "./queues.js";
import type { DeliveryRefs } from "./delivery.js";
import type { TenantCredentials } from "./cognee.js";
import type { DeliveryMode } from "./types.js";
import type { CatchJob, CommandJob, IngestJob } from "./queues.js";

export async function startQueue(): Promise<PgBoss> {
  const boss = new PgBoss(config.databaseUrl);
  await boss.start();
  await boss.createQueue(QUEUE.ingest);
  await boss.createQueue(QUEUE.catch);
  await boss.createQueue(QUEUE.command);
  await boss.work<IngestJob>(QUEUE.ingest, ingestWorker);
  await boss.work<CatchJob>(QUEUE.catch, catchWorker);
  await boss.work<CommandJob>(QUEUE.command, (jobs) => commandWorker(jobs, boss));
  return boss;
}

// Backfill (whole repo) or live single-item ingest -> extract decision -> remember().
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

// PR opened/updated or issue opened -> precision pipeline -> deliver (or stay silent).
async function catchWorker(jobs: PgBoss.Job<CatchJob>[]): Promise<void> {
  for (const { data } of jobs) {
    const inst = await db.getInstallation(data.installationId);
    if (!inst) continue;
    const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
    const cfg = await db.getTenantConfig(data.installationId);

    // Issues have no diff/check — deliver a plain comment before code is written.
    if (data.kind === "issue") {
      const it = await gh.fetchItem(data.installationId, data.repo, data.number);
      const sessionId = `codeguard-issue-${data.installationId}-${data.number}`;
      const judgment = await evaluatePr(inst, cfg, creds, `${it.title}\n\n${it.body}`, sessionId);
      if (judgment.matches && judgment.decisionId && judgment.comment && cfg.autoComment) {
        await gh.postComment(data.installationId, data.repo, data.number, `⚠️ ${judgment.comment}`);
      }
      await db.upsertDelivery({
        installationId: data.installationId,
        repo: data.repo,
        prNumber: data.number,
        kind: "issue",
        headSha: "",
        mode: "comment",
        decisionId: judgment.decisionId,
        sessionId,
        state: judgment.matches ? "posted" : "clear",
      });
      continue;
    }

    const pr = await gh.fetchPr(data.installationId, data.repo, data.number);
    const [owner, repo] = data.repo.split("/");
    const octokit = await gh.installationOctokit(data.installationId);
    const ctx = {
      octokit,
      owner,
      repo,
      number: data.number,
      headSha: pr.headSha,
      externalId: `${data.installationId}:${data.repo}#${data.number}`,
    };
    const delivery = resolveDelivery(cfg.deliveryMode);

    // Idempotency per head_sha: synchronize re-runs reuse the same check/review/comment.
    const prior = await db.getDelivery(data.installationId, data.repo, data.number, pr.headSha);
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
    const sessionId = `codeguard-pr-${data.installationId}-${data.number}`;
    const judgment = await evaluatePr(inst, cfg, creds, prText, sessionId);
    const decision = await buildDecision(inst, cfg, pr, judgment);

    if (cfg.autoComment) {
      refs = decision.findings.length ? await delivery.publish(ctx, refs, decision) : await delivery.clear(ctx, refs);
    }

    await db.upsertDelivery({
      installationId: data.installationId,
      repo: data.repo,
      prNumber: data.number,
      kind: "pr",
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

async function commandWorker(jobs: PgBoss.Job<CommandJob>[], boss: PgBoss): Promise<void> {
  for (const { data } of jobs) await handleCommand(data, boss);
}
