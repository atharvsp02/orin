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
      repo            TEXT   NOT NULL DEFAULT '',
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
      PRIMARY KEY (installation_id, repo, decision_id)
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
    CREATE TABLE IF NOT EXISTS preflight_keys (
      key_hash        TEXT PRIMARY KEY,
      installation_id BIGINT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
      repo            TEXT   NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at      TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS feedback_pending (
      installation_id BIGINT NOT NULL,
      session_id      TEXT   NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (installation_id, session_id)
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
       (decision_id, installation_id, repo, source_type, source_url, title, outcome, reasoning_text, decided_at, terms, superseded_by, cognee_data_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (installation_id, repo, decision_id) DO UPDATE
       SET outcome        = EXCLUDED.outcome,
           reasoning_text = EXCLUDED.reasoning_text,
           terms          = EXCLUDED.terms,
           superseded_by  = EXCLUDED.superseded_by,
           cognee_data_id = EXCLUDED.cognee_data_id`,
    [
      d.decisionId, d.installationId, d.repo, d.sourceType, d.sourceUrl, d.title, d.outcome,
      d.reasoningText, d.decidedAt || null, d.terms, d.supersededBy ?? null, d.cogneeDataId ?? null,
    ],
  );
}

// Link reversals: mark prior records (in the same repo) referenced by a superseding decision.
export async function markSuperseded(
  installationId: number,
  repo: string,
  refs: string[],
  supersededBy: string,
): Promise<void> {
  for (const ref of refs) {
    const num = ref.match(/\d+/)?.[0];
    if (!num) continue;
    await pool.query(
      `UPDATE decision_records SET superseded_by = $1
       WHERE installation_id = $2 AND repo = $3 AND decision_id LIKE $4 AND decision_id <> $5`,
      [supersededBy, installationId, repo, `%-${num}`, supersededBy],
    );
  }
}

export async function getDecisionRecords(installationId: number, repo: string): Promise<DecisionRecord[]> {
  const { rows } = await pool.query(
    `SELECT * FROM decision_records WHERE installation_id = $1 AND repo = $2`,
    [installationId, repo],
  );
  return rows.map((r) => ({
    decisionId: r.decision_id,
    installationId: Number(r.installation_id),
    repo: r.repo ?? "",
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

// The decision CodeGuard most recently flagged on a PR/issue (for `@codeguard override` with no ref).
export async function getLatestDecisionForPr(installationId: number, repo: string, number: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT decision_id FROM deliveries
     WHERE installation_id = $1 AND repo = $2 AND number = $3 AND decision_id IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [installationId, repo, number],
  );
  return rows[0]?.decision_id ?? null;
}

export async function ignoreDeliveries(installationId: number, repo: string, number: number): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET state = 'ignored', updated_at = now()
     WHERE installation_id = $1 AND repo = $2 AND number = $3`,
    [installationId, repo, number],
  );
}

// Guard against cross-repo IDOR: an override may only target a decision CodeGuard actually
// flagged on THIS repo+thread (repos in one installation share a dataset and can collide on ids).
export async function decisionFlaggedOnThread(
  installationId: number,
  repo: string,
  number: number,
  decisionId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM deliveries
     WHERE installation_id = $1 AND repo = $2 AND number = $3 AND decision_id = $4 LIMIT 1`,
    [installationId, repo, number, decisionId],
  );
  return rows.length > 0;
}

// Supersede one exact decision id in one repo (precise — unlike markSuperseded's number-suffix match).
export async function setSuperseded(
  installationId: number,
  repo: string,
  decisionId: string,
  supersededBy: string,
): Promise<void> {
  await pool.query(
    `UPDATE decision_records SET superseded_by = $1
     WHERE installation_id = $2 AND repo = $3 AND decision_id = $4 AND decision_id <> $1`,
    [supersededBy, installationId, repo, decisionId],
  );
}

export async function getDecisionRecord(
  installationId: number,
  repo: string,
  decisionId: string,
): Promise<DecisionRecord | null> {
  const { rows } = await pool.query(
    `SELECT * FROM decision_records WHERE installation_id = $1 AND repo = $2 AND decision_id = $3`,
    [installationId, repo, decisionId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    decisionId: r.decision_id,
    installationId: Number(r.installation_id),
    repo: r.repo ?? "",
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

// Repo-scoped pre-flight key: maps a hashed `cg_…` token to one installation + repo.
export async function lookupPreflightKey(keyHash: string): Promise<{ installationId: number; repo: string } | null> {
  const { rows } = await pool.query(
    `SELECT installation_id, repo FROM preflight_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash],
  );
  const r = rows[0];
  if (!r) return null;
  return { installationId: Number(r.installation_id), repo: r.repo };
}

export async function insertPreflightKey(keyHash: string, installationId: number, repo: string): Promise<void> {
  await pool.query(
    `INSERT INTO preflight_keys (key_hash, installation_id, repo) VALUES ($1, $2, $3)
     ON CONFLICT (key_hash) DO NOTHING`,
    [keyHash, installationId, repo],
  );
}

// --- feedback lifecycle: sessions that got a 👍/👎 and are due for /improve ---

export async function recordFeedbackPending(installationId: number, sessionId: string): Promise<void> {
  await pool.query(
    `INSERT INTO feedback_pending (installation_id, session_id) VALUES ($1, $2)
     ON CONFLICT (installation_id, session_id) DO NOTHING`,
    [installationId, sessionId],
  );
}

// Atomically take everything pending (race-safe: DELETE … RETURNING), grouped per installation.
export async function drainFeedbackPending(): Promise<Map<number, string[]>> {
  const { rows } = await pool.query(`DELETE FROM feedback_pending RETURNING installation_id, session_id`);
  const byInstall = new Map<number, string[]>();
  for (const r of rows) {
    const id = Number(r.installation_id);
    (byInstall.get(id) ?? byInstall.set(id, []).get(id)!).push(r.session_id);
  }
  return byInstall;
}

export async function listInstallations(): Promise<Installation[]> {
  const { rows } = await pool.query(`SELECT installation_id FROM installations`);
  const out: Installation[] = [];
  for (const r of rows) {
    const inst = await getInstallation(Number(r.installation_id));
    if (inst) out.push(inst);
  }
  return out;
}

export interface RepoMetrics {
  prsPrevented: number; // distinct PRs where CodeGuard flagged a re-proposed decision
  decisionsTracked: number;
  rejectionsActive: number; // rejected + not yet superseded (what the catch enforces)
}

export async function metrics(installationId: number, repo: string): Promise<RepoMetrics> {
  const prevented = await pool.query(
    `SELECT COUNT(DISTINCT number)::int AS n FROM deliveries
     WHERE installation_id = $1 AND repo = $2 AND kind = 'pr' AND decision_id IS NOT NULL AND state = 'posted'`,
    [installationId, repo],
  );
  const tracked = await pool.query(
    `SELECT COUNT(*)::int AS n FROM decision_records WHERE installation_id = $1 AND repo = $2`,
    [installationId, repo],
  );
  const rejections = await pool.query(
    `SELECT COUNT(*)::int AS n FROM decision_records
     WHERE installation_id = $1 AND repo = $2 AND outcome = 'rejected' AND superseded_by IS NULL`,
    [installationId, repo],
  );
  return {
    prsPrevented: prevented.rows[0]?.n ?? 0,
    decisionsTracked: tracked.rows[0]?.n ?? 0,
    rejectionsActive: rejections.rows[0]?.n ?? 0,
  };
}

// Full teardown on uninstall. installations delete cascades tenant_config/decision_records/preflight_keys;
// deliveries + feedback_pending carry no FK, so clear them explicitly.
export async function deleteInstallation(installationId: number): Promise<void> {
  await pool.query(`DELETE FROM deliveries WHERE installation_id = $1`, [installationId]);
  await pool.query(`DELETE FROM feedback_pending WHERE installation_id = $1`, [installationId]);
  await pool.query(`DELETE FROM installations WHERE installation_id = $1`, [installationId]);
}
