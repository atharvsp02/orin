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
      llm_provider         TEXT NOT NULL DEFAULT 'google'
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
    CREATE TABLE IF NOT EXISTS pr_comments (
      installation_id BIGINT NOT NULL,
      repo            TEXT   NOT NULL,
      pr_number       INT    NOT NULL,
      decision_id     TEXT,
      session_id      TEXT,
      posted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (installation_id, repo, pr_number)
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

export async function alreadyCommented(installationId: number, repo: string, prNumber: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM pr_comments WHERE installation_id = $1 AND repo = $2 AND pr_number = $3`,
    [installationId, repo, prNumber],
  );
  return rows.length > 0;
}

export async function recordComment(
  installationId: number,
  repo: string,
  prNumber: number,
  decisionId: string | null,
  sessionId: string | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO pr_comments (installation_id, repo, pr_number, decision_id, session_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [installationId, repo, prNumber, decisionId, sessionId],
  );
}

// Resolve the recall session for a PR (used to attach maintainer feedback).
export async function getPrSession(installationId: number, repo: string, prNumber: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT session_id FROM pr_comments WHERE installation_id = $1 AND repo = $2 AND pr_number = $3`,
    [installationId, repo, prNumber],
  );
  return rows[0]?.session_id ?? null;
}
