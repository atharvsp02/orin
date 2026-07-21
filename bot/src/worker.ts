import PgBoss from "pg-boss";
import { config } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { ingestItem, evaluatePr, matchRules } from "./pipeline.js";
import { resolveDelivery, buildDecision } from "./delivery.js";
import { handleCommand } from "./commands.js";
import { runImprove } from "./lifecycle.js";
import { CATCH_RETRY_OPTIONS, QUEUE, catchFailureRecord } from "./queues.js";
import type { DeliveryRefs } from "./delivery.js";
import type { TenantCredentials } from "./cognee.js";
import type { DeliveryMode } from "./types.js";
import type { CatchJob, CommandJob, IngestJob } from "./queues.js";
import type { DriveSyncJob } from "./queues.js";
import { runGoogleDriveSync } from "./google-drive.js";
import * as enterprise from "./enterprise-db.js";
import * as content from "./content-db.js";

export async function startQueue(): Promise<PgBoss> {
  const boss = new PgBoss(config.databaseUrl);
  await boss.start();
  await content.failStaleConnectorSyncs();
  await enterprise.pruneExpiredRateLimits();
  await boss.createQueue(QUEUE.ingest);
  await boss.createQueue(QUEUE.catch, { name: QUEUE.catch, ...CATCH_RETRY_OPTIONS });
  await boss.updateQueue(QUEUE.catch, { name: QUEUE.catch, ...CATCH_RETRY_OPTIONS });
  await boss.createQueue(QUEUE.command);
  await boss.createQueue(QUEUE.lifecycle);
  await boss.createQueue(QUEUE.driveSync);
  await boss.createQueue(QUEUE.connectorScheduler);
  await boss.work<IngestJob>(QUEUE.ingest, ingestWorker);
  await boss.work<CatchJob>(QUEUE.catch, { includeMetadata: true }, catchWorker);
  await boss.work<CommandJob>(QUEUE.command, (jobs) => commandWorker(jobs, boss));
  await boss.work(QUEUE.lifecycle, () => runImprove());
  await boss.work<DriveSyncJob>(QUEUE.driveSync, async (jobs) => {
    for (const job of jobs) await runGoogleDriveSync(job.data);
  });
  await boss.work(QUEUE.connectorScheduler, async () => {
    await enterprise.pruneExpiredRateLimits();
    await content.failStaleConnectorSyncs();
    for (const connector of await db.listActiveConnectorsByProvider("gdrive")) {
      await boss.send(QUEUE.driveSync, {
        workspaceId: connector.workspaceId,
        connectorId: connector.connectorId,
      } satisfies DriveSyncJob, {
        singletonKey: connector.connectorId,
        singletonSeconds: 15 * 60,
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
      });
    }
  });
  // Apply accumulated maintainer feedback to the graph once an hour (the /improve verb).
  await boss.schedule(QUEUE.lifecycle, "0 * * * *");
  await boss.schedule(QUEUE.connectorScheduler, "*/15 * * * *");
  return boss;
}

// Backfill (whole repo) or live single-item ingest -> extract decision -> remember().
async function ingestWorker(jobs: PgBoss.Job<IngestJob>[]): Promise<void> {
  for (const { data } of jobs) {
    if (!(await db.connectorAllowsResource("github", String(data.installationId), "repository", data.repo))) continue;
    const inst = await db.getInstallation(data.installationId);
    if (!inst) {
      console.warn("ingest: unknown installation", data.installationId);
      continue;
    }
    const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
    const cfg = await db.getTenantConfig(data.installationId);

    if (data.number != null) {
      const it = await gh.fetchItem(data.installationId, data.repo, data.number);
      await ingestItem(inst, cfg, creds, it, data.repo);
      continue;
    }
    const items = await gh.fetchClosedItems(data.installationId, data.repo, data.limit ?? 50);
    for (const it of items) await ingestItem(inst, cfg, creds, it, data.repo);
    console.log(`ingest done: ${data.repo} (${items.length} items scanned)`);
  }
}

// PR opened/updated or issue opened -> precision pipeline -> deliver (or stay silent).
async function catchWorker(jobs: PgBoss.JobWithMetadata<CatchJob>[]): Promise<void> {
  for (const job of jobs) {
    try {
      await runCatch(job.data);
    } catch (error) {
      const failure = catchFailureRecord(job.data, error, job.retryCount >= job.retryLimit);
      console.error(
        `catch ${job.data.repo}#${job.data.number} attempt ${job.retryCount + 1}/${job.retryLimit + 1} failed: ${failure.errorText}`,
      );
      await db.upsertDelivery(failure).catch((dbError) => {
        const message = dbError instanceof Error ? dbError.message : String(dbError);
        console.error(`catch failure status could not be stored: ${message}`);
      });
      throw error;
    }
  }
}

async function runCatch(data: CatchJob): Promise<void> {
  if (!(await db.connectorAllowsResource("github", String(data.installationId), "repository", data.repo))) return;
  const inst = await db.getInstallation(data.installationId);
  if (!inst) return;
  const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
  const cfg = await db.getTenantConfig(data.installationId);

  // Issues have no diff/check — deliver a plain comment before code is written.
  if (data.kind === "issue") {
    const prior = await db.getDelivery(data.installationId, data.repo, data.number, "");
    if (prior?.state === "posted") return;
    await db.upsertDelivery({
      installationId: data.installationId,
      repo: data.repo,
      prNumber: data.number,
      kind: "issue",
      headSha: "",
      mode: "comment",
      state: "processing",
    });
    const it = await gh.fetchItem(data.installationId, data.repo, data.number);
    const sessionId = `orin-issue-${data.installationId}-${data.number}`;
    const judgment = await evaluatePr(inst, cfg, creds, `${it.title}\n\n${it.body}`, data.repo, sessionId);
    let commentId: number | null = null;
    if (judgment.matches && judgment.decisionId && judgment.comment && cfg.autoComment) {
      commentId = await gh.postComment(data.installationId, data.repo, data.number, `⚠️ ${judgment.comment}`);
    }
    await db.upsertDelivery({
      installationId: data.installationId,
      repo: data.repo,
      prNumber: data.number,
      kind: "issue",
      headSha: "",
      mode: "comment",
      commentId,
      decisionId: judgment.decisionId,
      sessionId: judgment.matches ? sessionId : null, // a recall session exists only when we flagged
      state: judgment.matches ? "posted" : "clear",
    });
    return;
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
  const sessionId = `orin-pr-${data.installationId}-${data.number}`;
  const judgment = await evaluatePr(inst, cfg, creds, prText, data.repo, sessionId);
  // Advisory coding-rule hints only enrich an existing re-proposal finding (kept out of the blocking gate).
  const rules = judgment.matches ? await matchRules(inst, cfg, creds, prText, data.repo) : [];
  const decision = await buildDecision(inst, cfg, data.repo, pr, judgment, rules);

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
    sessionId: judgment.matches ? sessionId : null, // a recall session exists only when we flagged
    state: decision.findings.length ? "posted" : "clear",
  });
  await db.clearTransientCatchFailure(data.installationId, data.repo, data.number);
}

async function commandWorker(jobs: PgBoss.Job<CommandJob>[], boss: PgBoss): Promise<void> {
  for (const { data } of jobs) {
    if (!(await db.connectorAllowsResource("github", String(data.installationId), "repository", data.repo))) continue;
    await handleCommand(data, boss);
  }
}
