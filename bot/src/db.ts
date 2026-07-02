import { Pool } from "pg";
import { config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import type { DecisionRecord, Installation, TenantConfig } from "./types.js";

const pool = new Pool({ connectionString: config.databaseUrl });

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS installations (
      installation_id BIGINT PRIMARY KEY,
      github_account  TEXT NOT NULL,
      dataset_name    TEXT NOT NULL,
      cognee_api_key  TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tenant_config (
      installation_id      BIGINT PRIMARY KEY REFERENCES installations(installation_id) ON DELETE CASCADE,
      tone                 TEXT NOT NULL DEFAULT 'friendly',
      watch_paths          TEXT[] NOT NULL DEFAULT '{}',
      confidence_threshold INT  NOT NULL DEFAULT 2,
      score_cutoff         REAL NOT NULL DEFAULT 0.6,
      auto_comment         BOOLEAN NOT NULL DEFAULT true,
      custom_instructions  TEXT NOT NULL DEFAULT '',
      llm_provider         TEXT NOT NULL DEFAULT 'google',
      delivery_mode        TEXT NOT NULL DEFAULT 'check',
      block_on_repropose   BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS decision_records (
      decision_id     TEXT   NOT NULL,
      installation_id BIGINT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
      source_type     TEXT   NOT NULL,
      source_url      TEXT   NOT NULL,
      title           TEXT   NOT NULL,
      outcome         TEXT   NOT NULL,
      reasoning_text  TEXT   NOT NULL,
      decided_at      TEXT,
      terms           TEXT[] NOT NULL DEFAULT '{}',
      superseded_by   TEXT,
      cognee_data_id  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (installation_id, decision_id)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      installation_id BIGINT NOT NULL,
      repo            TEXT   NOT NULL,
      number          INT    NOT NULL,
      kind            TEXT   NOT NULL DEFAULT 'pr',
      head_sha        TEXT   NOT NULL DEFAULT '',
      mode            TEXT,
      check_run_id    BIGINT,
      review_id       BIGINT,
      comment_id      BIGINT,
      decision_id     TEXT,
      session_id      TEXT,
      state           TEXT   NOT NULL DEFAULT 'posted',
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (installation_id, repo, number, head_sha)
    );
  `);
}

export async function upsertInstallation(i: {
  installationId: number;
  githubAccount: string;
  datasetName: string;
  cogneeApiKey: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO installations (installation_id, github_account, dataset_name, cognee_api_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (installation_id) DO UPDATE
       SET github_account = EXCLUDED.github_account,
           dataset_name   = EXCLUDED.dataset_name,
           cognee_api_key = EXCLUDED.cognee_api_key`,
    [i.installationId, i.githubAccount, i.datasetName, encrypt(i.cogneeApiKey)],
  );
  await pool.query(`INSERT INTO tenant_config (installation_id) VALUES ($1) ON CONFLICT DO NOTHING`, [i.installationId]);
}

export async function getInstallation(installationId: number): Promise<Installation | null> {
  const { rows } = await pool.query(`SELECT * FROM installations WHERE installation_id = $1`, [installationId]);
  const r = rows[0];
  if (!r) return null;
  return {
    installationId: Number(r.installation_id),
    githubAccount: r.github_account,
    datasetName: r.dataset_name,
    cogneeApiKey: decrypt(r.cognee_api_key),
    createdAt: String(r.created_at),
  };
}

export async function getTenantConfig(installationId: number): Promise<TenantConfig> {
  const { rows } = await pool.query(`SELECT * FROM tenant_config WHERE installation_id = $1`, [installationId]);
  const r = rows[0] ?? {};
  return {
    installationId,
    tone: r.tone ?? "friendly",
    watchPaths: r.watch_paths ?? [],
    confidenceThreshold: r.confidence_threshold ?? 2,
    scoreCutoff: r.score_cutoff ?? 0.6,
    autoComment: r.auto_comment ?? true,
    customInstructions: r.custom_instructions ?? "",
    llmProvider: r.llm_provider ?? "google",
    deliveryMode: r.delivery_mode ?? "check",
    blockOnRepropose: r.block_on_repropose ?? true,
  };
}

export async function upsertDecisionRecord(d: DecisionRecord): Promise<void> {
  await pool.query(
    `INSERT INTO decision_records
       (decision_id, installation_id, source_type, source_url, title, outcome, reasoning_text, decided_at, terms, superseded_by, cognee_data_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (installation_id, decision_id) DO UPDATE
       SET outcome        = EXCLUDED.outcome,
           reasoning_text = EXCLUDED.reasoning_text,
           terms          = EXCLUDED.terms,
           superseded_by  = EXCLUDED.superseded_by,
           cognee_data_id = EXCLUDED.cognee_data_id`,
    [
      d.decisionId, d.installationId, d.sourceType, d.sourceUrl, d.title, d.outcome,
      d.reasoningText, d.decidedAt || null, d.terms, d.supersededBy ?? null, d.cogneeDataId ?? null,
    ],
  );
}

// Link reversals: mark prior records referenced by a superseding decision (by issue/PR number).
export async function markSuperseded(installationId: number, refs: string[], supersededBy: string): Promise<void> {
  for (const ref of refs) {
    const num = ref.match(/\d+/)?.[0];
    if (!num) continue;
    await pool.query(
      `UPDATE decision_records SET superseded_by = $1
       WHERE installation_id = $2 AND decision_id LIKE $3 AND decision_id <> $4`,
      [supersededBy, installationId, `%-${num}`, supersededBy],
    );
  }
}

export async function getDecisionRecords(installationId: number): Promise<DecisionRecord[]> {
  const { rows } = await pool.query(`SELECT * FROM decision_records WHERE installation_id = $1`, [installationId]);
  return rows.map((r) => ({
    decisionId: r.decision_id,
    installationId: Number(r.installation_id),
    sourceType: r.source_type,
    sourceUrl: r.source_url,
    title: r.title,
    outcome: r.outcome,
    reasoningText: r.reasoning_text,
    decidedAt: r.decided_at ?? "",
    terms: r.terms ?? [],
    supersededBy: r.superseded_by ?? undefined,
    cogneeDataId: r.cognee_data_id ?? undefined,
    createdAt: String(r.created_at),
  }));
}

export interface DeliveryRow {
  mode: string | null;
  checkRunId: number | null;
  reviewId: number | null;
  commentId: number | null;
  decisionId: string | null;
  sessionId: string | null;
  state: string;
}

// Prior delivery for a specific PR commit (idempotency across synchronize re-runs).
export async function getDelivery(
  installationId: number,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<DeliveryRow | null> {
  const { rows } = await pool.query(
    `SELECT mode, check_run_id, review_id, comment_id, decision_id, session_id, state
     FROM deliveries WHERE installation_id = $1 AND repo = $2 AND number = $3 AND head_sha = $4`,
    [installationId, repo, prNumber, headSha],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    mode: r.mode,
    checkRunId: r.check_run_id,
    reviewId: r.review_id,
    commentId: r.comment_id,
    decisionId: r.decision_id,
    sessionId: r.session_id,
    state: r.state,
  };
}

export async function upsertDelivery(d: {
  installationId: number;
  repo: string;
  prNumber: number;
  kind?: string;
  headSha: string;
  mode?: string | null;
  checkRunId?: number | null;
  reviewId?: number | null;
  commentId?: number | null;
  decisionId?: string | null;
  sessionId?: string | null;
  state?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO deliveries
       (installation_id, repo, number, kind, head_sha, mode, check_run_id, review_id, comment_id, decision_id, session_id, state, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (installation_id, repo, number, head_sha) DO UPDATE SET
       mode=EXCLUDED.mode, check_run_id=EXCLUDED.check_run_id, review_id=EXCLUDED.review_id,
       comment_id=EXCLUDED.comment_id, decision_id=EXCLUDED.decision_id, session_id=EXCLUDED.session_id,
       state=EXCLUDED.state, updated_at=now()`,
    [
      d.installationId, d.repo, d.prNumber, d.kind ?? "pr", d.headSha, d.mode ?? null,
      d.checkRunId ?? null, d.reviewId ?? null, d.commentId ?? null, d.decisionId ?? null,
      d.sessionId ?? null, d.state ?? "posted",
    ],
  );
}

// Latest recall session for a PR (used to attach maintainer feedback).
export async function getPrSession(installationId: number, repo: string, prNumber: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT session_id FROM deliveries
     WHERE installation_id = $1 AND repo = $2 AND number = $3 AND session_id IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [installationId, repo, prNumber],
  );
  return rows[0]?.session_id ?? null;
}

export async function getDecisionRecord(installationId: number, decisionId: string): Promise<DecisionRecord | null> {
  const { rows } = await pool.query(
    `SELECT * FROM decision_records WHERE installation_id = $1 AND decision_id = $2`,
    [installationId, decisionId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    decisionId: r.decision_id,
    installationId: Number(r.installation_id),
    sourceType: r.source_type,
    sourceUrl: r.source_url,
    title: r.title,
    outcome: r.outcome,
    reasoningText: r.reasoning_text,
    decidedAt: r.decided_at ?? "",
    terms: r.terms ?? [],
    supersededBy: r.superseded_by ?? undefined,
    cogneeDataId: r.cognee_data_id ?? undefined,
    createdAt: String(r.created_at),
  };
}
