import PgBoss from "pg-boss";
import { config } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { ingestItem, evaluatePr } from "./pipeline.js";
import type { TenantCredentials } from "./cognee.js";

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
    if (await db.alreadyCommented(data.installationId, data.repo, data.prNumber)) continue;
    const inst = await db.getInstallation(data.installationId);
    if (!inst) continue;
    const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
    const cfg = await db.getTenantConfig(data.installationId);
    const pr = await gh.fetchPr(data.installationId, data.repo, data.prNumber);
    const prText = `${pr.title}\n\n${pr.body}\n\nFiles: ${pr.files.join(", ")}`;

    const judgment = await evaluatePr(inst, cfg, creds, prText);
    if (judgment.matches && judgment.decisionId && judgment.comment) {
      if (cfg.autoComment) await gh.postComment(data.installationId, data.repo, data.prNumber, judgment.comment);
      await db.recordComment(data.installationId, data.repo, data.prNumber, judgment.decisionId);
    }
  }
}
