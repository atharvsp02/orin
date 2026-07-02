import PgBoss from "pg-boss";

export const QUEUE = { ingest: "ingest", catch: "catch" } as const;

export async function startQueue(): Promise<PgBoss> {
  const boss = new PgBoss(process.env.DATABASE_URL!);
  await boss.start();
  await boss.work(QUEUE.ingest, ingestWorker);
  await boss.work(QUEUE.catch, catchWorker);
  return boss;
}

// Backfill / doc ingest -> extract a decision record -> remember() into the dataset.
async function ingestWorker(jobs: PgBoss.Job[]): Promise<void> {
  for (const job of jobs) {
    console.log("ingest", job.data);
    // 1. resolve installation -> Cognee X-Api-Key + dataset
    // 2. backfill: paginate signal-rich issues/PRs, enqueue per-item ingests
    // 3. extract DecisionRecord (outcome / reasoning / terms) via the app-layer LLM
    // 4. remember() into dataset + upsert decision_records (idempotent by source id)
  }
}

// PR opened -> precision pipeline (docs/specs) -> post one cited comment, or stay silent.
async function catchWorker(jobs: PgBoss.Job[]): Promise<void> {
  for (const job of jobs) {
    console.log("catch", job.data);
    // 1. resolve creds + dataset; load tenant_config
    // 2. fetch PR (title / body / diff) via the installation token
    // 3. deterministic term match vs decision_records + CHUNKS+verbose semantic pass
    // 4. grounding gate (term overlap) + outcome/recency filter
    // 5. app-layer judgment LLM: resemble a candidate? draft a comment citing its decision_id, else no-match
    // 6. citation-resolution gate + one-comment-per-PR idempotency -> post the comment
  }
}
