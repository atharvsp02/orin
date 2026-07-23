import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import {
  CONNECTOR_CAPABILITIES,
  normalizeCapabilities,
  normalizeConnectorRef,
  type ConnectorAccount,
  type ConnectorResource,
  type ConnectorStatus,
  type Workspace,
} from "./connectors.js";
import { decrypt, encrypt } from "./crypto.js";
import type { DecisionRecord, Installation, TenantConfig } from "./types.js";

export const pool = new Pool({ connectionString: config.databaseUrl });
const SYNTHETIC_INSTALLATION_FLOOR = 1_000_000_000_000;

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
      llm_provider         TEXT NOT NULL DEFAULT 'openai',
      delivery_mode        TEXT NOT NULL DEFAULT 'check',
      block_on_repropose   BOOLEAN NOT NULL DEFAULT true
    );
    ALTER TABLE tenant_config ALTER COLUMN llm_provider SET DEFAULT 'openai';
    UPDATE tenant_config SET llm_provider = 'openai' WHERE llm_provider = 'deepseek';
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
      error_text      TEXT,
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
    CREATE TABLE IF NOT EXISTS tenant_links (
      platform        TEXT   NOT NULL,
      external_id     TEXT   NOT NULL,
      installation_id BIGINT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (platform, external_id)
    );
    CREATE TABLE IF NOT EXISTS slack_installs (
      id         TEXT PRIMARY KEY,   -- team id (or enterprise id for org installs)
      data       TEXT NOT NULL,      -- AES-256-GCM ciphertext (holds OAuth bot tokens)
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS linear_installs (
      id         TEXT PRIMARY KEY,   -- Linear organization id
      data       TEXT NOT NULL,      -- AES-256-GCM ciphertext (OAuth access token)
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS link_codes (
      code_hash   TEXT PRIMARY KEY,  -- sha256 of the one-time code
      platform    TEXT NOT NULL,     -- workspace that minted it (e.g. 'slack')
      external_id TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS docs (
      installation_id BIGINT NOT NULL,
      filename        TEXT   NOT NULL,
      title           TEXT   NOT NULL,
      repo            TEXT   NOT NULL DEFAULT '',  -- '' = org-wide
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (installation_id, filename)
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id          UUID PRIMARY KEY,
      legacy_installation_id BIGINT UNIQUE,
      display_name          TEXT NOT NULL,
      dataset_name          TEXT NOT NULL,
      cognee_api_key        TEXT NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS connectors (
      connector_id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      provider     TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      capabilities  TEXT[] NOT NULL DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, external_id)
    );
    CREATE TABLE IF NOT EXISTS connector_resources (
      resource_id UUID PRIMARY KEY,
      connector_id UUID NOT NULL REFERENCES connectors(connector_id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      kind         TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled      BOOLEAN NOT NULL DEFAULT true,
      acl_status   TEXT NOT NULL DEFAULT 'current' CHECK (acl_status IN ('current', 'stale', 'failed')),
      acl_synced_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (connector_id, kind, external_id)
    );
    ALTER TABLE connector_resources ADD COLUMN IF NOT EXISTS acl_status TEXT NOT NULL DEFAULT 'current';
    ALTER TABLE connector_resources ADD COLUMN IF NOT EXISTS acl_synced_at TIMESTAMPTZ;
    DO $$ BEGIN
      ALTER TABLE connector_resources ADD CONSTRAINT connector_resources_acl_status_check
        CHECK (acl_status IN ('current', 'stale', 'failed'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE TABLE IF NOT EXISTS connector_resource_memberships (
      workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      resource_id  UUID NOT NULL REFERENCES connector_resources(resource_id) ON DELETE CASCADE,
      principal    TEXT NOT NULL,
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (resource_id, principal)
    );
    CREATE INDEX IF NOT EXISTS connector_resource_memberships_principal_idx
      ON connector_resource_memberships (workspace_id, principal, resource_id);
    CREATE TABLE IF NOT EXISTS users (
      user_id       UUID PRIMARY KEY,
      display_name  TEXT NOT NULL,
      primary_email TEXT NOT NULL DEFAULT '',
      avatar_url    TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_primary_email_unique
      ON users (lower(primary_email)) WHERE primary_email <> '';
    CREATE TABLE IF NOT EXISTS user_identities (
      provider      TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      handle        TEXT NOT NULL DEFAULT '',
      email         TEXT NOT NULL DEFAULT '',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);
    CREATE TABLE IF NOT EXISTS workspace_memberships (
      workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
      status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_memberships_user_idx
      ON workspace_memberships (user_id, status);
    CREATE TABLE IF NOT EXISTS workspace_groups (
      group_id     UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      external_id  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (group_id, workspace_id),
      UNIQUE (workspace_id, display_name)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_groups_external_unique
      ON workspace_groups (workspace_id, external_id) WHERE external_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS workspace_group_members (
      workspace_id UUID NOT NULL,
      group_id     UUID NOT NULL,
      user_id      UUID NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, user_id),
      FOREIGN KEY (group_id, workspace_id)
        REFERENCES workspace_groups(group_id, workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS workspace_group_members_user_idx
      ON workspace_group_members (workspace_id, user_id);
    CREATE TABLE IF NOT EXISTS permission_grants (
      grant_id      UUID PRIMARY KEY,
      workspace_id  UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      principal_type TEXT NOT NULL CHECK (principal_type IN ('role', 'user', 'group')),
      principal_id  TEXT NOT NULL,
      permission    TEXT NOT NULL,
      effect        TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
      conditions    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, principal_type, principal_id, permission, conditions)
    );
    CREATE INDEX IF NOT EXISTS permission_grants_workspace_idx
      ON permission_grants (workspace_id, principal_type, principal_id);
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id      UUID PRIMARY KEY,
      workspace_id  UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      actor_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      action        TEXT NOT NULL,
      target_type   TEXT NOT NULL,
      target_id     TEXT NOT NULL,
      outcome       TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied', 'failure')),
      request_id    TEXT NOT NULL DEFAULT '',
      ip_hash       TEXT NOT NULL DEFAULT '',
      details       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS audit_events_workspace_time_idx
      ON audit_events (workspace_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS connector_credentials (
      connector_id  UUID PRIMARY KEY REFERENCES connectors(connector_id) ON DELETE CASCADE,
      encrypted_data TEXT NOT NULL,
      scopes         TEXT[] NOT NULL DEFAULT '{}',
      expires_at     TIMESTAMPTZ,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS connector_policies (
      policy_id     UUID PRIMARY KEY,
      workspace_id  UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      connector_id  UUID NOT NULL REFERENCES connectors(connector_id) ON DELETE CASCADE,
      effect         TEXT NOT NULL CHECK (effect IN ('include', 'exclude')),
      field          TEXT NOT NULL,
      operator       TEXT NOT NULL CHECK (operator IN ('equals', 'contains', 'starts_with', 'one_of')),
      values         TEXT[] NOT NULL,
      enabled        BOOLEAN NOT NULL DEFAULT true,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS connector_policies_connector_idx
      ON connector_policies (workspace_id, connector_id, enabled);
    CREATE TABLE IF NOT EXISTS connector_sync_runs (
      run_id         UUID PRIMARY KEY,
      workspace_id   UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      connector_id   UUID NOT NULL REFERENCES connectors(connector_id) ON DELETE CASCADE,
      status         TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'partial')),
      cursor_value   TEXT NOT NULL DEFAULT '',
      items_seen     INT NOT NULL DEFAULT 0,
      items_written  INT NOT NULL DEFAULT 0,
      items_deleted  INT NOT NULL DEFAULT 0,
      error_text     TEXT NOT NULL DEFAULT '',
      started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at    TIMESTAMPTZ
    );
    ALTER TABLE connector_sync_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS connector_sync_runs_connector_time_idx
      ON connector_sync_runs (connector_id, started_at DESC);
    WITH duplicate_syncs AS (
      SELECT run_id, row_number() OVER (PARTITION BY connector_id ORDER BY started_at DESC, run_id DESC) AS position
      FROM connector_sync_runs WHERE status = 'running'
    )
    UPDATE connector_sync_runs SET
      status = 'failed', error_text = 'superseded incomplete sync', finished_at = now()
    WHERE run_id IN (SELECT run_id FROM duplicate_syncs WHERE position > 1);
    CREATE UNIQUE INDEX IF NOT EXISTS connector_sync_runs_running_unique
      ON connector_sync_runs (connector_id) WHERE status = 'running';
    CREATE TABLE IF NOT EXISTS content_items (
      item_id          UUID PRIMARY KEY,
      workspace_id     UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      connector_id     UUID NOT NULL REFERENCES connectors(connector_id) ON DELETE CASCADE,
      resource_id      UUID REFERENCES connector_resources(resource_id) ON DELETE SET NULL,
      external_id      TEXT NOT NULL,
      source_type      TEXT NOT NULL,
      title            TEXT NOT NULL,
      body             TEXT NOT NULL,
      url              TEXT NOT NULL DEFAULT '',
      mime_type        TEXT NOT NULL DEFAULT 'text/plain',
      owner_key        TEXT NOT NULL DEFAULT '',
      source_path      TEXT NOT NULL DEFAULT '',
      visibility       TEXT NOT NULL DEFAULT 'restricted' CHECK (visibility IN ('workspace', 'restricted')),
      acl_status       TEXT NOT NULL DEFAULT 'stale' CHECK (acl_status IN ('current', 'stale', 'failed')),
      content_hash     TEXT NOT NULL,
      metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_created_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ,
      indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_sync_run_id UUID REFERENCES connector_sync_runs(run_id) ON DELETE SET NULL,
      deleted_at       TIMESTAMPTZ,
      search_vector    TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(body, '')), 'B')
      ) STORED,
      UNIQUE (connector_id, external_id)
    );
    CREATE INDEX IF NOT EXISTS content_items_workspace_idx
      ON content_items (workspace_id, connector_id, resource_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS content_items_search_idx ON content_items USING GIN (search_vector);
    ALTER TABLE content_items ADD COLUMN IF NOT EXISTS last_seen_sync_run_id UUID REFERENCES connector_sync_runs(run_id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS content_acl_entries (
      item_id         UUID NOT NULL REFERENCES content_items(item_id) ON DELETE CASCADE,
      principal_type  TEXT NOT NULL,
      principal_key   TEXT NOT NULL,
      principal       TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, principal)
    );
    CREATE INDEX IF NOT EXISTS content_acl_entries_principal_idx
      ON content_acl_entries (principal, item_id);
    CREATE TABLE IF NOT EXISTS chat_threads (
      thread_id      UUID PRIMARY KEY,
      workspace_id   UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      title          TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_threads_user_time_idx
      ON chat_threads (workspace_id, user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS chat_messages (
      message_id     UUID PRIMARY KEY,
      thread_id      UUID NOT NULL REFERENCES chat_threads(thread_id) ON DELETE CASCADE,
      role           TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content        TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_thread_time_idx
      ON chat_messages (thread_id, created_at, message_id);
    CREATE TABLE IF NOT EXISTS chat_citations (
      message_id     UUID NOT NULL REFERENCES chat_messages(message_id) ON DELETE CASCADE,
      item_id        UUID NOT NULL REFERENCES content_items(item_id) ON DELETE CASCADE,
      ordinal        INT NOT NULL CHECK (ordinal > 0),
      PRIMARY KEY (message_id, ordinal),
      UNIQUE (message_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS request_rate_limits (
      workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      action       TEXT NOT NULL,
      bucket       BIGINT NOT NULL,
      request_count INT NOT NULL DEFAULT 1,
      expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day',
      PRIMARY KEY (workspace_id, user_id, action, bucket)
    );
    ALTER TABLE request_rate_limits ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day';
    CREATE INDEX IF NOT EXISTS request_rate_limits_expiry_idx ON request_rate_limits (expires_at);
    ALTER TABLE preflight_keys ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
    ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS error_text TEXT;
    INSERT INTO workspaces
      (workspace_id, legacy_installation_id, display_name, dataset_name, cognee_api_key, created_at, updated_at)
    SELECT
      md5('orin-workspace:' || installation_id::text)::uuid,
      installation_id,
      github_account,
      dataset_name,
      cognee_api_key,
      created_at,
      now()
    FROM installations
    ON CONFLICT (legacy_installation_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      dataset_name = EXCLUDED.dataset_name,
      cognee_api_key = EXCLUDED.cognee_api_key,
      updated_at = now();
    INSERT INTO connectors
      (connector_id, workspace_id, provider, external_id, display_name, status, capabilities)
    SELECT
      md5('orin-connector:github:' || i.installation_id::text)::uuid,
      w.workspace_id,
      'github',
      i.installation_id::text,
      i.github_account,
      'active',
      ARRAY['ingest', 'query', 'record', 'warn', 'deliver']::TEXT[]
    FROM installations i
    JOIN workspaces w ON w.legacy_installation_id = i.installation_id
    WHERE i.installation_id < ${SYNTHETIC_INSTALLATION_FLOOR}
    ON CONFLICT (provider, external_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      display_name = EXCLUDED.display_name,
      status = EXCLUDED.status,
      capabilities = EXCLUDED.capabilities,
      updated_at = now();
    INSERT INTO connectors
      (connector_id, workspace_id, provider, external_id, display_name, status, capabilities)
    SELECT
      md5('orin-connector:' || l.platform || ':' || l.external_id)::uuid,
      w.workspace_id,
      l.platform,
      l.external_id,
      l.platform || ':' || l.external_id,
      'active',
      ARRAY['ingest', 'query', 'record', 'warn', 'deliver']::TEXT[]
    FROM tenant_links l
    JOIN workspaces w ON w.legacy_installation_id = l.installation_id
    ON CONFLICT (provider, external_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      status = EXCLUDED.status,
      updated_at = now();
    INSERT INTO connector_resources
      (resource_id, connector_id, external_id, kind, display_name, enabled)
    SELECT DISTINCT
      md5('orin-resource:' || c.connector_id::text || ':repository:' || d.repo)::uuid,
      c.connector_id,
      d.repo,
      'repository',
      d.repo,
      true
    FROM decision_records d
    JOIN workspaces w ON w.legacy_installation_id = d.installation_id
    JOIN connectors c ON c.workspace_id = w.workspace_id AND c.provider = 'github'
    WHERE d.repo <> ''
    ON CONFLICT (connector_id, kind, external_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      updated_at = now();
  `);
}

function workspaceFromRow(row: Record<string, unknown>): Workspace {
  return {
    workspaceId: String(row.workspace_id),
    legacyInstallationId: row.legacy_installation_id == null ? undefined : Number(row.legacy_installation_id),
    displayName: String(row.display_name),
    datasetName: String(row.dataset_name),
    cogneeApiKey: decrypt(String(row.cognee_api_key)),
    createdAt: String(row.created_at),
  };
}

function connectorFromRow(row: Record<string, unknown>): ConnectorAccount {
  return {
    connectorId: String(row.connector_id),
    workspaceId: String(row.workspace_id),
    provider: String(row.provider),
    externalId: String(row.external_id),
    displayName: String(row.display_name),
    status: String(row.status) as ConnectorStatus,
    capabilities: normalizeCapabilities(Array.isArray(row.capabilities) ? row.capabilities.map(String) : []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function resourceFromRow(row: Record<string, unknown>): ConnectorResource {
  return {
    resourceId: String(row.resource_id),
    connectorId: String(row.connector_id),
    externalId: String(row.external_id),
    kind: String(row.kind),
    displayName: String(row.display_name),
    enabled: Boolean(row.enabled),
    aclStatus: String(row.acl_status ?? "current") as ConnectorResource["aclStatus"],
    aclSyncedAt: row.acl_synced_at == null ? undefined : String(row.acl_synced_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function createWorkspace(input: {
  workspaceId?: string;
  displayName: string;
  datasetName: string;
  cogneeApiKey: string;
}): Promise<Workspace> {
  const workspaceId = input.workspaceId ?? randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO workspaces (workspace_id, display_name, dataset_name, cognee_api_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       dataset_name = EXCLUDED.dataset_name,
       cognee_api_key = EXCLUDED.cognee_api_key,
       updated_at = now()
     RETURNING *`,
    [workspaceId, input.displayName, input.datasetName, encrypt(input.cogneeApiKey)],
  );
  return workspaceFromRow(rows[0]);
}

export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  const { rows } = await pool.query(`SELECT * FROM workspaces WHERE workspace_id = $1`, [workspaceId]);
  return rows[0] ? workspaceFromRow(rows[0]) : null;
}

export async function getWorkspaceByInstallation(installationId: number): Promise<Workspace | null> {
  const { rows } = await pool.query(`SELECT * FROM workspaces WHERE legacy_installation_id = $1`, [installationId]);
  return rows[0] ? workspaceFromRow(rows[0]) : null;
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await pool.query(`DELETE FROM workspaces WHERE workspace_id = $1`, [workspaceId]);
}

export async function upsertConnector(input: {
  connectorId?: string;
  workspaceId: string;
  provider: string;
  externalId: string;
  displayName: string;
  status?: ConnectorStatus;
  capabilities: readonly string[];
}): Promise<ConnectorAccount> {
  const ref = normalizeConnectorRef(input);
  const capabilities = normalizeCapabilities(input.capabilities);
  const { rows } = await pool.query(
    `INSERT INTO connectors
       (connector_id, workspace_id, provider, external_id, display_name, status, capabilities)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, external_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       capabilities = EXCLUDED.capabilities,
       updated_at = now()
     RETURNING *`,
    [input.connectorId ?? randomUUID(), input.workspaceId, ref.provider, ref.externalId, input.displayName, input.status ?? "active", capabilities],
  );
  return connectorFromRow(rows[0]);
}

export async function getConnector(provider: string, externalId: string): Promise<ConnectorAccount | null> {
  const ref = normalizeConnectorRef({ provider, externalId });
  const { rows } = await pool.query(
    `SELECT * FROM connectors WHERE provider = $1 AND external_id = $2`,
    [ref.provider, ref.externalId],
  );
  return rows[0] ? connectorFromRow(rows[0]) : null;
}

export async function getConnectorById(workspaceId: string, connectorId: string): Promise<ConnectorAccount | null> {
  const { rows } = await pool.query(
    `SELECT * FROM connectors WHERE workspace_id = $1 AND connector_id = $2`,
    [workspaceId, connectorId],
  );
  return rows[0] ? connectorFromRow(rows[0]) : null;
}

export async function listConnectors(workspaceId: string): Promise<ConnectorAccount[]> {
  const { rows } = await pool.query(
    `SELECT * FROM connectors WHERE workspace_id = $1 ORDER BY provider, display_name`,
    [workspaceId],
  );
  return rows.map(connectorFromRow);
}

export async function listActiveConnectorsByProvider(provider: string): Promise<ConnectorAccount[]> {
  const normalized = normalizeConnectorRef({ provider, externalId: "placeholder" }).provider;
  const { rows } = await pool.query(
    `SELECT * FROM connectors WHERE provider = $1 AND status = 'active' ORDER BY workspace_id, connector_id`,
    [normalized],
  );
  return rows.map(connectorFromRow);
}

export async function setConnectorEnabled(
  workspaceId: string,
  connectorId: string,
  enabled: boolean,
): Promise<ConnectorAccount | null> {
  const { rows } = await pool.query(
    `UPDATE connectors
     SET status = $3, updated_at = now()
     WHERE workspace_id = $1 AND connector_id = $2
     RETURNING *`,
    [workspaceId, connectorId, enabled ? "active" : "disabled"],
  );
  return rows[0] ? connectorFromRow(rows[0]) : null;
}

export async function setConnectorStatus(
  workspaceId: string,
  connectorId: string,
  status: ConnectorStatus,
): Promise<ConnectorAccount | null> {
  const { rows } = await pool.query(
    `UPDATE connectors SET status = $3, updated_at = now()
     WHERE workspace_id = $1 AND connector_id = $2
     RETURNING *`,
    [workspaceId, connectorId, status],
  );
  return rows[0] ? connectorFromRow(rows[0]) : null;
}

export async function deleteConnector(provider: string, externalId: string): Promise<void> {
  const ref = normalizeConnectorRef({ provider, externalId });
  await pool.query(`DELETE FROM connectors WHERE provider = $1 AND external_id = $2`, [ref.provider, ref.externalId]);
}

export async function upsertConnectorResource(input: {
  resourceId?: string;
  connectorId: string;
  externalId: string;
  kind: string;
  displayName: string;
  enabled?: boolean;
}): Promise<ConnectorResource> {
  const externalId = input.externalId.trim();
  const kind = input.kind.trim().toLowerCase();
  if (!externalId) throw new Error("connector resource external id is required");
  if (!kind) throw new Error("connector resource kind is required");
  const { rows } = await pool.query(
    `INSERT INTO connector_resources
       (resource_id, connector_id, external_id, kind, display_name, enabled)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, true))
     ON CONFLICT (connector_id, kind, external_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       enabled = COALESCE($6, connector_resources.enabled),
       updated_at = now()
     RETURNING *`,
    [input.resourceId ?? randomUUID(), input.connectorId, externalId, kind, input.displayName, input.enabled ?? null],
  );
  return resourceFromRow(rows[0]);
}

export async function listConnectorResources(connectorId: string): Promise<ConnectorResource[]> {
  const { rows } = await pool.query(
    `SELECT * FROM connector_resources WHERE connector_id = $1 ORDER BY kind, display_name`,
    [connectorId],
  );
  return rows.map(resourceFromRow);
}

export async function getConnectorResource(
  connectorId: string,
  kind: string,
  externalId: string,
): Promise<ConnectorResource | null> {
  const { rows } = await pool.query(
    `SELECT * FROM connector_resources WHERE connector_id = $1 AND kind = $2 AND external_id = $3`,
    [connectorId, kind.trim().toLowerCase(), externalId.trim()],
  );
  return rows[0] ? resourceFromRow(rows[0]) : null;
}

export async function getConnectorForResource(workspaceId: string, resourceId: string): Promise<ConnectorAccount | null> {
  const { rows } = await pool.query(
    `SELECT connector.* FROM connectors connector
     JOIN connector_resources resource ON resource.connector_id = connector.connector_id
     WHERE connector.workspace_id = $1 AND resource.resource_id = $2`,
    [workspaceId, resourceId],
  );
  return rows[0] ? connectorFromRow(rows[0]) : null;
}

export async function setConnectorResourceEnabled(
  workspaceId: string,
  resourceId: string,
  enabled: boolean,
): Promise<ConnectorResource | null> {
  const { rows } = await pool.query(
    `UPDATE connector_resources AS resource
     SET enabled = $3, updated_at = now()
     FROM connectors AS connector
     WHERE resource.resource_id = $2
       AND resource.connector_id = connector.connector_id
       AND connector.workspace_id = $1
     RETURNING resource.*`,
    [workspaceId, resourceId, enabled],
  );
  return rows[0] ? resourceFromRow(rows[0]) : null;
}

export async function connectorAllowsResource(
  provider: string,
  externalId: string,
  kind: string,
  resourceExternalId: string,
): Promise<boolean> {
  const ref = normalizeConnectorRef({ provider, externalId });
  const normalizedKind = kind.trim().toLowerCase();
  const normalizedResourceId = resourceExternalId.trim();
  if (!normalizedKind || !normalizedResourceId) return false;
  const { rows } = await pool.query(
    `SELECT connector.status, resource.enabled
     FROM connectors AS connector
     LEFT JOIN connector_resources AS resource
       ON resource.connector_id = connector.connector_id
      AND resource.kind = $3
      AND resource.external_id = $4
     WHERE connector.provider = $1 AND connector.external_id = $2`,
    [ref.provider, ref.externalId, normalizedKind, normalizedResourceId],
  );
  if (!rows[0] || rows[0].status !== "active") return false;
  return rows[0].enabled === null || rows[0].enabled === undefined || rows[0].enabled === true;
}

async function syncInstallationWorkspace(i: {
  installationId: number;
  githubAccount: string;
  datasetName: string;
  cogneeApiKey: string;
}): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO workspaces
       (workspace_id, legacy_installation_id, display_name, dataset_name, cognee_api_key)
     VALUES (md5('orin-workspace:' || $1::bigint::text)::uuid, $1::bigint, $2, $3, $4)
     ON CONFLICT (legacy_installation_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       dataset_name = EXCLUDED.dataset_name,
       cognee_api_key = EXCLUDED.cognee_api_key,
       updated_at = now()
     RETURNING workspace_id`,
    [i.installationId, i.githubAccount, i.datasetName, encrypt(i.cogneeApiKey)],
  );
  if (i.installationId < SYNTHETIC_INSTALLATION_FLOOR) {
    await upsertConnector({
      workspaceId: String(rows[0].workspace_id),
      provider: "github",
      externalId: String(i.installationId),
      displayName: i.githubAccount,
      capabilities: CONNECTOR_CAPABILITIES,
    });
  }
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
  await syncInstallationWorkspace(i);
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
    llmProvider: r.llm_provider ?? "openai",
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
       SET source_type    = EXCLUDED.source_type,
           source_url     = EXCLUDED.source_url,
           title          = EXCLUDED.title,
           outcome        = EXCLUDED.outcome,
           reasoning_text = EXCLUDED.reasoning_text,
           decided_at     = EXCLUDED.decided_at,
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
// Only the exact GitHub-item ids for that number are matched (PR-<n> / ISSUE-<n>) — never a
// wildcard suffix — so a ref like "#42" can't collaterally supersede an unrelated DOC-42, and
// LLM-extracted refs from an untrusted closed thread have a bounded, exact blast radius.
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
       WHERE installation_id = $2 AND repo = $3 AND decision_id = ANY($4) AND decision_id <> $1`,
      [supersededBy, installationId, repo, [`PR-${num}`, `ISSUE-${num}`]],
    );
  }
}

// repo omitted ⇒ installation-wide (used by the platform-neutral adapters, which have no repo).
export async function getDecisionRecords(installationId: number, repo?: string): Promise<DecisionRecord[]> {
  const { rows } = await pool.query(
    repo === undefined
      ? `SELECT * FROM decision_records WHERE installation_id = $1`
      : `SELECT * FROM decision_records WHERE installation_id = $1 AND repo = $2`,
    repo === undefined ? [installationId] : [installationId, repo],
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
  errorText: string | null;
}

// Prior delivery for a specific PR commit (idempotency across synchronize re-runs).
export async function getDelivery(
  installationId: number,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<DeliveryRow | null> {
  const { rows } = await pool.query(
    `SELECT mode, check_run_id, review_id, comment_id, decision_id, session_id, state, error_text
     FROM deliveries WHERE installation_id = $1 AND repo = $2 AND number = $3 AND head_sha = $4`,
    [installationId, repo, prNumber, headSha],
  );
  const r = rows[0];
  if (!r) return null;
  // BIGINT columns come back as strings from node-postgres — coerce to number (ids are < 2^53).
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    mode: r.mode,
    checkRunId: num(r.check_run_id),
    reviewId: num(r.review_id),
    commentId: num(r.comment_id),
    decisionId: r.decision_id,
    sessionId: r.session_id,
    state: r.state,
    errorText: r.error_text,
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
  errorText?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO deliveries
       (installation_id, repo, number, kind, head_sha, mode, check_run_id, review_id, comment_id, decision_id, session_id, state, error_text, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (installation_id, repo, number, head_sha) DO UPDATE SET
       mode=EXCLUDED.mode, check_run_id=EXCLUDED.check_run_id, review_id=EXCLUDED.review_id,
       comment_id=EXCLUDED.comment_id, decision_id=EXCLUDED.decision_id, session_id=EXCLUDED.session_id,
       state=EXCLUDED.state, error_text=EXCLUDED.error_text, updated_at=now()`,
    [
      d.installationId, d.repo, d.prNumber, d.kind ?? "pr", d.headSha, d.mode ?? null,
      d.checkRunId ?? null, d.reviewId ?? null, d.commentId ?? null, d.decisionId ?? null,
      d.sessionId ?? null, d.state ?? "posted", d.errorText ?? null,
    ],
  );
}

export async function clearTransientCatchFailure(installationId: number, repo: string, number: number): Promise<void> {
  await pool.query(
    `DELETE FROM deliveries
     WHERE installation_id = $1 AND repo = $2 AND number = $3 AND head_sha = ''
       AND kind = 'pr' AND state IN ('retrying', 'failed')`,
    [installationId, repo, number],
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

export async function getLatestCommentIdForPr(
  installationId: number,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT comment_id FROM deliveries
     WHERE installation_id = $1 AND repo = $2 AND number = $3 AND comment_id IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [installationId, repo, prNumber],
  );
  return rows[0]?.comment_id == null ? null : Number(rows[0].comment_id);
}

// The decision Orin most recently flagged on a PR/issue (for `@orin override` with no ref).
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

// Guard against cross-repo IDOR: an override may only target a decision Orin actually
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

// Repo-scoped pre-flight key: maps a hashed `orin_…` token to one installation + repo.
export async function lookupPreflightKey(keyHash: string): Promise<{ installationId: number; repo: string } | null> {
  const { rows } = await pool.query(
    `SELECT installation_id, repo FROM preflight_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash],
  );
  const r = rows[0];
  if (!r) return null;
  return { installationId: Number(r.installation_id), repo: r.repo };
}

// --- tenant links: map a Slack team / Linear workspace to an existing (GitHub) installation ---

export async function linkTenant(platform: string, externalId: string, installationId: number): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_links (platform, external_id, installation_id) VALUES ($1, $2, $3)
     ON CONFLICT (platform, external_id) DO UPDATE SET installation_id = EXCLUDED.installation_id`,
    [platform, externalId, installationId],
  );
  const workspace = await getWorkspaceByInstallation(installationId);
  if (!workspace) throw new Error(`workspace missing for installation: ${installationId}`);
  await upsertConnector({
    workspaceId: workspace.workspaceId,
    provider: platform,
    externalId,
    displayName: `${platform}:${externalId}`,
    capabilities: CONNECTOR_CAPABILITIES,
  });
}

export async function resolveLink(platform: string, externalId: string): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT installation_id FROM tenant_links WHERE platform = $1 AND external_id = $2`,
    [platform, externalId],
  );
  return rows[0] ? Number(rows[0].installation_id) : null;
}

export async function unlinkTenant(platform: string, externalId: string): Promise<void> {
  await pool.query(`DELETE FROM tenant_links WHERE platform = $1 AND external_id = $2`, [platform, externalId]);
  await deleteConnector(platform, externalId);
}

// One-time cross-platform link codes: minted in Slack (ephemeral — only the requester sees it,
// bound to the minting workspace), consumed on GitHub by a write-access maintainer. Consuming
// links the MINTING workspace to THAT GitHub installation — a leaked used code grants nothing.
export async function insertLinkCode(codeHash: string, platform: string, externalId: string, ttlMinutes: number): Promise<void> {
  await pool.query(
    `INSERT INTO link_codes (code_hash, platform, external_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
     ON CONFLICT (code_hash) DO NOTHING`,
    [codeHash, platform, externalId, String(ttlMinutes)],
  );
}

// Atomic consume: single-use and unexpired, or null.
export async function consumeLinkCode(codeHash: string): Promise<{ platform: string; externalId: string } | null> {
  const { rows } = await pool.query(
    `UPDATE link_codes SET used_at = now()
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING platform, external_id`,
    [codeHash],
  );
  return rows[0] ? { platform: rows[0].platform, externalId: rows[0].external_id } : null;
}

export async function distinctRepos(installationId: number): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT repo FROM decision_records WHERE installation_id = $1 AND repo <> '' ORDER BY repo`,
    [installationId],
  );
  return rows.map((r) => r.repo);
}

export async function countDecisions(installationId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM decision_records WHERE installation_id = $1`,
    [installationId],
  );
  return rows[0]?.n ?? 0;
}

// Slack OAuth installation store (Bolt InstallationStore backing). The install object holds bot
// tokens (xoxb-…), so it is encrypted at rest with the same AES-256-GCM key as the Cognee keys.
export async function storeSlackInstall(id: string, data: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO slack_installs (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [id, encrypt(JSON.stringify(data))],
  );
}

export async function fetchSlackInstall(id: string): Promise<unknown | null> {
  const { rows } = await pool.query(`SELECT data FROM slack_installs WHERE id = $1`, [id]);
  return rows[0] ? JSON.parse(decrypt(rows[0].data)) : null;
}

export async function listSlackInstallationIds(): Promise<string[]> {
  const { rows } = await pool.query(`SELECT id FROM slack_installs ORDER BY id`);
  return rows.map((row) => String(row.id));
}

export async function deleteSlackInstall(id: string): Promise<void> {
  await pool.query(`DELETE FROM slack_installs WHERE id = $1`, [id]);
}

// Linear OAuth installs (one per organization), encrypted at rest like slack_installs.
export async function storeLinearInstall(id: string, data: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO linear_installs (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [id, encrypt(JSON.stringify(data))],
  );
}

export async function fetchLinearInstall(id: string): Promise<unknown | null> {
  const { rows } = await pool.query(`SELECT data FROM linear_installs WHERE id = $1`, [id]);
  return rows[0] ? JSON.parse(decrypt(rows[0].data)) : null;
}

export async function mutateLinearInstall(
  id: string,
  update: (current: unknown) => Promise<unknown>,
): Promise<unknown | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT data FROM linear_installs WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const next = await update(JSON.parse(decrypt(String(rows[0].data))));
    await client.query(
      `UPDATE linear_installs SET data = $2, updated_at = now() WHERE id = $1`,
      [id, encrypt(JSON.stringify(next))],
    );
    await client.query("COMMIT");
    return next;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteLinearInstall(id: string): Promise<void> {
  await pool.query(`DELETE FROM linear_installs WHERE id = $1`, [id]);
}

export async function insertPreflightKey(keyHash: string, installationId: number, repo: string, label = ""): Promise<void> {
  await pool.query(
    `INSERT INTO preflight_keys (key_hash, installation_id, repo, label) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key_hash) DO NOTHING`,
    [keyHash, installationId, repo, label],
  );
}

export interface KeyRow {
  keyHash: string;
  repo: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export async function listPreflightKeys(installationId: number): Promise<KeyRow[]> {
  const { rows } = await pool.query(
    `SELECT key_hash, repo, label, created_at, revoked_at FROM preflight_keys
     WHERE installation_id = $1 ORDER BY created_at DESC`,
    [installationId],
  );
  return rows.map((r) => ({
    keyHash: r.key_hash,
    repo: r.repo,
    label: r.label ?? "",
    createdAt: String(r.created_at),
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
  }));
}

// Scoped to the installation so one tenant can never revoke another tenant's key.
export async function revokePreflightKey(installationId: number, keyHash: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE preflight_keys SET revoked_at = now()
     WHERE installation_id = $1 AND key_hash = $2 AND revoked_at IS NULL`,
    [installationId, keyHash],
  );
  return (rowCount ?? 0) > 0;
}

// Installation-wide metrics (dashboard overview; the repo-scoped variant is metrics()).
export async function metricsAll(installationId: number): Promise<RepoMetrics> {
  const prevented = await pool.query(
    `SELECT COUNT(DISTINCT (repo, number))::int AS n FROM deliveries
     WHERE installation_id = $1 AND kind = 'pr' AND decision_id IS NOT NULL AND state = 'posted'`,
    [installationId],
  );
  const tracked = await pool.query(
    `SELECT COUNT(*)::int AS n FROM decision_records WHERE installation_id = $1`,
    [installationId],
  );
  const rejections = await pool.query(
    `SELECT COUNT(*)::int AS n FROM decision_records
     WHERE installation_id = $1 AND outcome = 'rejected' AND superseded_by IS NULL`,
    [installationId],
  );
  return {
    prsPrevented: prevented.rows[0]?.n ?? 0,
    decisionsTracked: tracked.rows[0]?.n ?? 0,
    rejectionsActive: rejections.rows[0]?.n ?? 0,
  };
}

export interface DeliveryFeedRow {
  repo: string;
  number: number;
  kind: string;
  decisionId: string | null;
  state: string;
  errorText: string | null;
  updatedAt: string;
}

// Recent catches feed for the dashboard overview.
export async function recentDeliveries(installationId: number, limit = 20): Promise<DeliveryFeedRow[]> {
  const { rows } = await pool.query(
    `SELECT repo, number, kind, decision_id, state, error_text, updated_at FROM deliveries
     WHERE installation_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [installationId, limit],
  );
  return rows.map((r) => ({
    repo: r.repo,
    number: Number(r.number),
    kind: r.kind,
    decisionId: r.decision_id,
    state: r.state,
    errorText: r.error_text,
    updatedAt: String(r.updated_at),
  }));
}

export async function recentDeliveriesForRepos(
  installationId: number,
  repos: string[],
  limit = 20,
): Promise<DeliveryFeedRow[]> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const allowedRepos = [...new Set(repos.map((repo) => repo.trim()).filter(Boolean))];
  if (allowedRepos.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT repo, number, kind, decision_id, state, error_text, updated_at FROM deliveries
     WHERE installation_id = $1 AND repo = ANY($2::text[])
     ORDER BY updated_at DESC LIMIT $3`,
    [installationId, allowedRepos, boundedLimit],
  );
  return rows.map((row) => ({
    repo: row.repo,
    number: Number(row.number),
    kind: row.kind,
    decisionId: row.decision_id,
    state: row.state,
    errorText: row.error_text,
    updatedAt: String(row.updated_at),
  }));
}

export async function countPreventedForRepos(installationId: number, repos: string[]): Promise<number> {
  const allowedRepos = [...new Set(repos.map((repo) => repo.trim()).filter(Boolean))];
  if (allowedRepos.length === 0) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT (repo, number))::int AS count FROM deliveries
     WHERE installation_id = $1 AND repo = ANY($2::text[]) AND kind = 'pr'
       AND decision_id IS NOT NULL AND state = 'posted'`,
    [installationId, allowedRepos],
  );
  return Number(rows[0]?.count ?? 0);
}

// Settings update from the dashboard (whitelisted columns only).
export async function updateTenantConfig(
  installationId: number,
  patch: Partial<Pick<TenantConfig, "deliveryMode" | "blockOnRepropose" | "autoComment" | "confidenceThreshold" | "scoreCutoff" | "customInstructions" | "llmProvider" | "tone">>,
): Promise<void> {
  const cols: Record<string, unknown> = {};
  if (patch.deliveryMode !== undefined) cols.delivery_mode = patch.deliveryMode;
  if (patch.blockOnRepropose !== undefined) cols.block_on_repropose = patch.blockOnRepropose;
  if (patch.autoComment !== undefined) cols.auto_comment = patch.autoComment;
  if (patch.confidenceThreshold !== undefined) cols.confidence_threshold = patch.confidenceThreshold;
  if (patch.scoreCutoff !== undefined) cols.score_cutoff = patch.scoreCutoff;
  if (patch.customInstructions !== undefined) cols.custom_instructions = patch.customInstructions;
  if (patch.llmProvider !== undefined) cols.llm_provider = patch.llmProvider;
  if (patch.tone !== undefined) cols.tone = patch.tone;
  const keys = Object.keys(cols);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(`UPDATE tenant_config SET ${sets} WHERE installation_id = $1`, [installationId, ...keys.map((k) => cols[k])]);
}

// Which external workspaces (slack/linear) point at this installation's memory.
export async function linksFor(installationId: number): Promise<Array<{ platform: string; externalId: string }>> {
  const { rows } = await pool.query(
    `SELECT platform, external_id FROM tenant_links WHERE installation_id = $1`,
    [installationId],
  );
  return rows.map((r) => ({ platform: r.platform, externalId: r.external_id }));
}

export interface DocRow {
  filename: string;
  title: string;
  repo: string;
  createdAt: string;
}

export async function insertDoc(installationId: number, filename: string, title: string, repo: string): Promise<void> {
  await pool.query(
    `INSERT INTO docs (installation_id, filename, title, repo) VALUES ($1, $2, $3, $4)
     ON CONFLICT (installation_id, filename) DO UPDATE SET title = EXCLUDED.title, repo = EXCLUDED.repo, created_at = now()`,
    [installationId, filename, title, repo],
  );
}

export async function listDocs(installationId: number): Promise<DocRow[]> {
  const { rows } = await pool.query(
    `SELECT filename, title, repo, created_at FROM docs WHERE installation_id = $1 ORDER BY created_at DESC`,
    [installationId],
  );
  return rows.map((r) => ({ filename: r.filename, title: r.title, repo: r.repo, createdAt: String(r.created_at) }));
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
  prsPrevented: number; // distinct PRs where Orin flagged a re-proposed decision
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
  const workspace = await getWorkspaceByInstallation(installationId);
  await pool.query(`DELETE FROM deliveries WHERE installation_id = $1`, [installationId]);
  await pool.query(`DELETE FROM feedback_pending WHERE installation_id = $1`, [installationId]);
  await pool.query(`DELETE FROM installations WHERE installation_id = $1`, [installationId]);
  if (workspace) await deleteWorkspace(workspace.workspaceId);
}
