import { createHash, randomUUID } from "node:crypto";
import { normalizePrincipal } from "./access.js";
import {
  CONTENT_POLICY_FIELDS,
  CONTENT_POLICY_OPERATORS,
  contentAllowed,
  searchSnippet,
  type ContentPolicy,
  type ContentPolicyField,
  type ContentPolicyOperator,
  type ContentPolicyTarget,
} from "./content.js";
import type { WorkspacePermission } from "./access.js";
import { decrypt, encrypt } from "./crypto.js";
import { pool } from "./db.js";
import { userContentPrincipals } from "./enterprise-db.js";

const MAX_CONTENT_BYTES = 2_000_000;

export interface ContentItem {
  itemId: string;
  workspaceId: string;
  connectorId: string;
  resourceId?: string;
  externalId: string;
  sourceType: string;
  title: string;
  body: string;
  url: string;
  mimeType: string;
  ownerKey: string;
  sourcePath: string;
  visibility: "workspace" | "restricted";
  aclStatus: "current" | "stale" | "failed";
  contentHash: string;
  metadata: Record<string, unknown>;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  indexedAt: string;
  lastSyncedAt: string;
  deletedAt?: string;
}

export interface ContentAcl {
  principalType: string;
  principalKey: string;
}

export interface SearchResult {
  itemId: string;
  connectorId: string;
  resourceId?: string;
  provider: string;
  sourceType: string;
  title: string;
  snippet: string;
  url: string;
  mimeType: string;
  score: number;
  sourceUpdatedAt?: string;
}

export interface StoredConnectorPolicy extends ContentPolicy {
  policyId: string;
  workspaceId: string;
  connectorId: string;
}

export interface ConnectorSyncRun {
  runId: string;
  workspaceId: string;
  connectorId: string;
  status: "running" | "succeeded" | "failed" | "partial";
  cursorValue: string;
  itemsSeen: number;
  itemsWritten: number;
  itemsDeleted: number;
  errorText: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
}

function cleanText(value: string, name: string, maxLength: number): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${name} is required`);
  if (cleaned.length > maxLength) throw new Error(`${name} is too long`);
  return cleaned;
}

function optionalTimestamp(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid source timestamp");
  return date.toISOString();
}

function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentFromRow(row: Record<string, unknown>): ContentItem {
  return {
    itemId: String(row.item_id),
    workspaceId: String(row.workspace_id),
    connectorId: String(row.connector_id),
    resourceId: row.resource_id == null ? undefined : String(row.resource_id),
    externalId: String(row.external_id),
    sourceType: String(row.source_type),
    title: String(row.title),
    body: String(row.body),
    url: String(row.url ?? ""),
    mimeType: String(row.mime_type),
    ownerKey: String(row.owner_key ?? ""),
    sourcePath: String(row.source_path ?? ""),
    visibility: String(row.visibility) as ContentItem["visibility"],
    aclStatus: String(row.acl_status) as ContentItem["aclStatus"],
    contentHash: String(row.content_hash),
    metadata: metadata(row.metadata),
    sourceCreatedAt: row.source_created_at == null ? undefined : String(row.source_created_at),
    sourceUpdatedAt: row.source_updated_at == null ? undefined : String(row.source_updated_at),
    indexedAt: String(row.indexed_at),
    lastSyncedAt: String(row.last_synced_at),
    deletedAt: row.deleted_at == null ? undefined : String(row.deleted_at),
  };
}

export async function storeConnectorCredentials(input: {
  connectorId: string;
  data: Record<string, unknown>;
  scopes?: string[];
  expiresAt?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO connector_credentials (connector_id, encrypted_data, scopes, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (connector_id) DO UPDATE SET
       encrypted_data = EXCLUDED.encrypted_data,
       scopes = EXCLUDED.scopes,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      input.connectorId,
      encrypt(JSON.stringify(input.data)),
      [...new Set(input.scopes?.map((scope) => scope.trim()).filter(Boolean) ?? [])],
      optionalTimestamp(input.expiresAt),
    ],
  );
}

export async function getConnectorCredentials(connectorId: string): Promise<{
  data: Record<string, unknown>;
  scopes: string[];
  expiresAt?: string;
} | null> {
  const { rows } = await pool.query(`SELECT * FROM connector_credentials WHERE connector_id = $1`, [connectorId]);
  if (!rows[0]) return null;
  const parsed = JSON.parse(decrypt(String(rows[0].encrypted_data))) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid connector credentials");
  return {
    data: parsed as Record<string, unknown>,
    scopes: Array.isArray(rows[0].scopes) ? rows[0].scopes.map(String) : [],
    expiresAt: rows[0].expires_at == null ? undefined : String(rows[0].expires_at),
  };
}

export async function deleteConnectorCredentials(connectorId: string): Promise<void> {
  await pool.query(`DELETE FROM connector_credentials WHERE connector_id = $1`, [connectorId]);
}

export async function upsertContentItem(input: {
  workspaceId: string;
  connectorId: string;
  resourceId?: string;
  externalId: string;
  sourceType: string;
  title: string;
  body: string;
  url?: string;
  mimeType?: string;
  ownerKey?: string;
  sourcePath?: string;
  visibility?: ContentItem["visibility"];
  aclStatus?: ContentItem["aclStatus"];
  acls?: ContentAcl[];
  metadata?: Record<string, unknown>;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  syncRunId?: string;
}): Promise<ContentItem> {
  const externalId = cleanText(input.externalId, "external id", 1000);
  const sourceType = cleanText(input.sourceType.toLowerCase(), "source type", 80);
  const title = cleanText(input.title, "title", 1000);
  if (Buffer.byteLength(input.body, "utf8") > MAX_CONTENT_BYTES) throw new Error("content exceeds 2 MB limit");
  const visibility = input.visibility ?? "restricted";
  const aclStatus = input.aclStatus ?? "stale";
  if (!["workspace", "restricted"].includes(visibility)) throw new Error("invalid content visibility");
  if (!["current", "stale", "failed"].includes(aclStatus)) throw new Error("invalid ACL status");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const connector = await client.query(
      `SELECT 1 FROM connectors WHERE connector_id = $1 AND workspace_id = $2`,
      [input.connectorId, input.workspaceId],
    );
    if (connector.rowCount !== 1) throw new Error("connector does not belong to workspace");
    if (input.resourceId) {
      const resource = await client.query(
        `SELECT 1 FROM connector_resources WHERE resource_id = $1 AND connector_id = $2`,
        [input.resourceId, input.connectorId],
      );
      if (resource.rowCount !== 1) throw new Error("resource does not belong to connector");
    }
    if (input.syncRunId) {
      const syncRun = await client.query(
        `SELECT 1 FROM connector_sync_runs
         WHERE run_id = $1 AND workspace_id = $2 AND connector_id = $3 AND status = 'running'`,
        [input.syncRunId, input.workspaceId, input.connectorId],
      );
      if (syncRun.rowCount !== 1) throw new Error("sync run does not belong to connector");
    }
    const body = input.body.trim();
    const contentHash = createHash("sha256").update(body).digest("hex");
    const { rows } = await client.query(
      `INSERT INTO content_items
         (item_id, workspace_id, connector_id, resource_id, external_id, source_type, title, body, url,
          mime_type, owner_key, source_path, visibility, acl_status, content_hash, metadata,
          source_created_at, source_updated_at, last_seen_sync_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (connector_id, external_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         resource_id = EXCLUDED.resource_id,
         source_type = EXCLUDED.source_type,
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         url = EXCLUDED.url,
         mime_type = EXCLUDED.mime_type,
         owner_key = EXCLUDED.owner_key,
         source_path = EXCLUDED.source_path,
         visibility = EXCLUDED.visibility,
         acl_status = EXCLUDED.acl_status,
         content_hash = EXCLUDED.content_hash,
         metadata = EXCLUDED.metadata,
         source_created_at = EXCLUDED.source_created_at,
         source_updated_at = EXCLUDED.source_updated_at,
         last_seen_sync_run_id = COALESCE(EXCLUDED.last_seen_sync_run_id, content_items.last_seen_sync_run_id),
         indexed_at = CASE WHEN content_items.content_hash <> EXCLUDED.content_hash THEN now() ELSE content_items.indexed_at END,
         last_synced_at = now(),
         deleted_at = NULL
       RETURNING *`,
      [
        randomUUID(), input.workspaceId, input.connectorId, input.resourceId ?? null, externalId, sourceType,
        title, body, input.url?.trim().slice(0, 4000) ?? "", input.mimeType?.trim().slice(0, 255) || "text/plain",
        input.ownerKey?.trim().slice(0, 320) ?? "", input.sourcePath?.trim().slice(0, 2000) ?? "",
        visibility, aclStatus, contentHash, input.metadata ?? {}, optionalTimestamp(input.sourceCreatedAt),
        optionalTimestamp(input.sourceUpdatedAt), input.syncRunId ?? null,
      ],
    );
    const item = contentFromRow(rows[0]);
    await client.query(`DELETE FROM content_acl_entries WHERE item_id = $1`, [item.itemId]);
    const principals = new Map<string, ContentAcl>();
    for (const acl of input.acls ?? []) {
      const principal = normalizePrincipal(acl.principalType, acl.principalKey);
      principals.set(principal, {
        principalType: acl.principalType.trim().toLowerCase(),
        principalKey: acl.principalKey.trim().toLowerCase(),
      });
    }
    for (const [principal, acl] of principals) {
      await client.query(
        `INSERT INTO content_acl_entries (item_id, principal_type, principal_key, principal)
         VALUES ($1, $2, $3, $4)`,
        [item.itemId, acl.principalType, acl.principalKey, principal],
      );
    }
    await client.query("COMMIT");
    return item;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markContentDeleted(workspaceId: string, connectorId: string, externalId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE content_items SET deleted_at = now(), last_synced_at = now()
     WHERE workspace_id = $1 AND connector_id = $2 AND external_id = $3 AND deleted_at IS NULL`,
    [workspaceId, connectorId, externalId],
  );
  return result.rowCount === 1;
}

export async function markContentSyncFailed(
  workspaceId: string,
  connectorId: string,
  externalId: string,
  runId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE content_items SET
       acl_status = 'failed', last_seen_sync_run_id = $4, last_synced_at = now()
     WHERE workspace_id = $1 AND connector_id = $2 AND external_id = $3 AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM connector_sync_runs
         WHERE run_id = $4 AND workspace_id = $1 AND connector_id = $2 AND status = 'running'
       )`,
    [workspaceId, connectorId, externalId, runId],
  );
  return result.rowCount === 1;
}

export async function markConnectorContentNotSeenInRun(
  workspaceId: string,
  connectorId: string,
  runId: string,
): Promise<number> {
  const result = await pool.query(
    `UPDATE content_items SET deleted_at = now()
     WHERE workspace_id = $1 AND connector_id = $2 AND deleted_at IS NULL
       AND last_seen_sync_run_id IS DISTINCT FROM $3
       AND EXISTS (
         SELECT 1 FROM connector_sync_runs
         WHERE run_id = $3 AND workspace_id = $1 AND connector_id = $2 AND status = 'running'
       )`,
    [workspaceId, connectorId, runId],
  );
  return result.rowCount ?? 0;
}

export async function replaceConnectorResourceMemberships(
  workspaceId: string,
  resourceId: string,
  acls: ContentAcl[],
): Promise<void> {
  const principals = [...new Set(acls.map((acl) => normalizePrincipal(acl.principalType, acl.principalKey)))];
  if (principals.length > 50_000) throw new Error("resource membership exceeds 50000 principals");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resource = await client.query(
      `SELECT 1 FROM connector_resources resource
       JOIN connectors connector ON connector.connector_id = resource.connector_id
       WHERE resource.resource_id = $1 AND connector.workspace_id = $2 FOR UPDATE OF resource`,
      [resourceId, workspaceId],
    );
    if (resource.rowCount !== 1) throw new Error("connector resource not found in workspace");
    await client.query(`DELETE FROM connector_resource_memberships WHERE resource_id = $1`, [resourceId]);
    if (principals.length > 0) {
      await client.query(
        `INSERT INTO connector_resource_memberships (workspace_id, resource_id, principal)
         SELECT $1, $2, principal FROM unnest($3::text[]) AS principal`,
        [workspaceId, resourceId, principals],
      );
    }
    await client.query(
      `UPDATE connector_resources SET acl_status = 'current', acl_synced_at = now(), updated_at = now()
       WHERE resource_id = $1`,
      [resourceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markConnectorResourceAclStatus(
  workspaceId: string,
  resourceId: string,
  status: "stale" | "failed",
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE connector_resources resource SET acl_status = $3, updated_at = now()
     FROM connectors connector
     WHERE resource.resource_id = $2 AND resource.connector_id = connector.connector_id
       AND connector.workspace_id = $1`,
    [workspaceId, resourceId, status],
  );
  return result.rowCount === 1;
}

export async function markConnectorResourcesAclStatus(
  workspaceId: string,
  connectorId: string,
  status: "stale" | "failed",
): Promise<number> {
  const result = await pool.query(
    `UPDATE connector_resources resource SET acl_status = $3, updated_at = now()
     FROM connectors connector
     WHERE resource.connector_id = $2 AND resource.connector_id = connector.connector_id
       AND connector.workspace_id = $1`,
    [workspaceId, connectorId, status],
  );
  return result.rowCount ?? 0;
}

function searchRow(row: Record<string, unknown>, query: string): SearchResult {
  return {
    itemId: String(row.item_id),
    connectorId: String(row.connector_id),
    resourceId: row.resource_id == null ? undefined : String(row.resource_id),
    provider: String(row.provider),
    sourceType: String(row.source_type),
    title: String(row.title),
    snippet: searchSnippet(String(row.body), query),
    url: String(row.url ?? ""),
    mimeType: String(row.mime_type),
    score: Number(row.score ?? 0),
    sourceUpdatedAt: row.source_updated_at == null ? undefined : String(row.source_updated_at),
  };
}

const SEARCH_STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "because", "did", "do", "does", "for", "how", "in", "is", "it",
  "me", "of", "on", "or", "our", "please", "tell", "that", "the", "this", "to", "was", "we",
  "were", "what", "when", "where", "who", "why", "with",
]);

export function searchTerms(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])
    .filter((token) => !SEARCH_STOP_WORDS.has(token)))]
    .slice(0, 32);
}

export function searchTsQuery(value: string): string {
  return searchTerms(value).join(" | ");
}

function featureConditionSql(grant: string, connector: string, item: string): string {
  return `(
    NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(${grant}.conditions) AS condition_key(value)
      WHERE condition_key.value NOT IN ('connectorProvider', 'resourceId', 'sourceType')
    ) AND
    (NOT (${grant}.conditions ? 'connectorProvider') OR CASE jsonb_typeof(${grant}.conditions->'connectorProvider')
      WHEN 'string' THEN lower(${grant}.conditions->>'connectorProvider') = lower(${connector}.provider)
      WHEN 'array' THEN lower(${connector}.provider) IN (
        SELECT lower(expected.value) FROM jsonb_array_elements_text(${grant}.conditions->'connectorProvider') AS expected(value)
      ) ELSE false END) AND
    (NOT (${grant}.conditions ? 'resourceId') OR CASE jsonb_typeof(${grant}.conditions->'resourceId')
      WHEN 'string' THEN lower(${grant}.conditions->>'resourceId') = lower(COALESCE(${item}.resource_id::text, ''))
      WHEN 'array' THEN lower(COALESCE(${item}.resource_id::text, '')) IN (
        SELECT lower(expected.value) FROM jsonb_array_elements_text(${grant}.conditions->'resourceId') AS expected(value)
      ) ELSE false END) AND
    (NOT (${grant}.conditions ? 'sourceType') OR CASE jsonb_typeof(${grant}.conditions->'sourceType')
      WHEN 'string' THEN lower(${grant}.conditions->>'sourceType') = lower(${item}.source_type)
      WHEN 'array' THEN lower(${item}.source_type) IN (
        SELECT lower(expected.value) FROM jsonb_array_elements_text(${grant}.conditions->'sourceType') AS expected(value)
      ) ELSE false END)
  )`;
}

function contentAclSql(item: string, acl: string, principalsParameter: string, userParameter: string): string {
  return `(
    (${acl}.principal_type NOT IN ('group', 'external_group', 'resource_member')
     AND ${acl}.principal = ANY(${principalsParameter}::text[])) OR
    (${acl}.principal_type = 'group' AND EXISTS (
      SELECT 1 FROM workspace_group_members membership
      WHERE membership.workspace_id = ${item}.workspace_id
        AND membership.user_id = ${userParameter}::uuid
        AND membership.group_id::text = lower(${acl}.principal_key)
    )) OR
    (${acl}.principal_type = 'external_group' AND EXISTS (
      SELECT 1 FROM workspace_group_members membership
      JOIN workspace_groups workspace_group ON workspace_group.group_id = membership.group_id
      WHERE membership.workspace_id = ${item}.workspace_id
        AND membership.user_id = ${userParameter}::uuid
        AND lower(workspace_group.external_id) = lower(${acl}.principal_key)
    )) OR
    (${acl}.principal_type = 'resource_member'
     AND ${acl}.principal = 'resource_member:' || lower(${item}.resource_id::text)
     AND EXISTS (
       SELECT 1 FROM connector_resource_memberships membership
       WHERE membership.workspace_id = ${item}.workspace_id
         AND membership.resource_id = ${item}.resource_id
         AND membership.principal = ANY(${principalsParameter}::text[])
     ))
  )`;
}

function featureAuthorizationSql(permissionParameter: string, connector: string, item: string): string {
  return `(
    ${permissionParameter}::text IS NULL OR (
      NOT EXISTS (
        SELECT 1 FROM feature_grants feature_grant
        WHERE feature_grant.effect = 'deny' AND ${featureConditionSql("feature_grant", connector, item)}
      ) AND (
        EXISTS (
          SELECT 1 FROM active_access access
          WHERE (${permissionParameter}::text = 'search.use' AND access.role IN ('owner', 'admin', 'member', 'viewer'))
             OR (${permissionParameter}::text = 'chat.use' AND access.role IN ('owner', 'admin', 'member'))
        ) OR EXISTS (
          SELECT 1 FROM feature_grants feature_grant
          WHERE feature_grant.effect = 'allow' AND ${featureConditionSql("feature_grant", connector, item)}
        )
      )
    )
  )`;
}

function connectorContentPolicySql(connector: string, item: string, resource: string): string {
  const actual = `(CASE policy.field
    WHEN 'provider' THEN ${connector}.provider
    WHEN 'resourceId' THEN COALESCE(${resource}.external_id, '')
    WHEN 'owner' THEN ${item}.owner_key
    WHEN 'mimeType' THEN ${item}.mime_type
    WHEN 'path' THEN ${item}.source_path
    WHEN 'sourceType' THEN ${item}.source_type
    ELSE '' END)`;
  const matches = `(CASE policy.operator
    WHEN 'equals' THEN EXISTS (
      SELECT 1 FROM unnest(policy.values) AS expected(value)
      WHERE lower(${actual}) = lower(expected.value)
    )
    WHEN 'one_of' THEN EXISTS (
      SELECT 1 FROM unnest(policy.values) AS expected(value)
      WHERE lower(${actual}) = lower(expected.value)
    )
    WHEN 'contains' THEN EXISTS (
      SELECT 1 FROM unnest(policy.values) AS expected(value)
      WHERE position(lower(expected.value) in lower(${actual})) > 0
    )
    WHEN 'starts_with' THEN EXISTS (
      SELECT 1 FROM unnest(policy.values) AS expected(value)
      WHERE left(lower(${actual}), length(expected.value)) = lower(expected.value)
    )
    ELSE false END)`;
  return `(
    NOT EXISTS (
      SELECT 1 FROM connector_policies policy
      WHERE policy.workspace_id = ${item}.workspace_id AND policy.connector_id = ${connector}.connector_id AND policy.enabled = true
        AND policy.effect = 'exclude' AND ${matches}
    ) AND (
      NOT EXISTS (
        SELECT 1 FROM connector_policies policy
        WHERE policy.workspace_id = ${item}.workspace_id AND policy.connector_id = ${connector}.connector_id AND policy.enabled = true
          AND policy.effect = 'include'
      ) OR EXISTS (
        SELECT 1 FROM connector_policies policy
        WHERE policy.workspace_id = ${item}.workspace_id AND policy.connector_id = ${connector}.connector_id AND policy.enabled = true
          AND policy.effect = 'include' AND ${matches}
      )
    )
  )`;
}

export async function authorizedSearch(input: {
  workspaceId: string;
  userId: string;
  permission?: Extract<WorkspacePermission, "search.use" | "chat.use">;
  query: string;
  provider?: string;
  resourceId?: string;
  limit?: number;
}): Promise<SearchResult[]> {
  const query = input.query.replace(/\s+/g, " ").trim();
  if (!query) throw new Error("query is required");
  if (query.length > 500) throw new Error("query is too long");
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 10), 50));
  const principals = [...await userContentPrincipals(input.userId, input.workspaceId)];
  if (principals.length === 0) return [];
  const { rows } = await pool.query(
    `WITH search_query AS (
            SELECT websearch_to_tsquery('simple', $3::text) AS exact,
                   to_tsquery('simple', $9::text) AS broad,
                   $10::text[] AS terms
          ),
          active_access AS (
            SELECT membership.role
            FROM workspace_memberships membership
            JOIN users app_user ON app_user.user_id = membership.user_id
            WHERE membership.workspace_id = $1::uuid AND membership.user_id = $7::uuid
              AND membership.status = 'active' AND app_user.status = 'active'
          ),
          feature_grants AS (
            SELECT stored_grant.effect, stored_grant.conditions
            FROM permission_grants stored_grant
            CROSS JOIN active_access access
            WHERE stored_grant.workspace_id = $1::uuid AND stored_grant.permission = $8::text AND (
              (stored_grant.principal_type = 'role' AND stored_grant.principal_id = access.role) OR
              (stored_grant.principal_type = 'user' AND stored_grant.principal_id = $7::text) OR
              (stored_grant.principal_type = 'group' AND EXISTS (
                SELECT 1 FROM workspace_group_members membership
                WHERE membership.workspace_id = $1::uuid AND membership.user_id = $7::uuid
                  AND membership.group_id::text = stored_grant.principal_id
              ))
            )
          )
     SELECT i.*, c.provider,
            (ts_rank_cd(i.search_vector, q.exact) +
             ts_rank_cd(i.search_vector, q.broad) * 0.35 +
             CASE WHEN i.source_updated_at > now() - interval '30 days' THEN 0.05 ELSE 0 END) AS score
     FROM content_items i
     JOIN connectors c ON c.connector_id = i.connector_id AND c.workspace_id = i.workspace_id
     LEFT JOIN connector_resources r ON r.resource_id = i.resource_id AND r.connector_id = i.connector_id
     CROSS JOIN search_query q
     WHERE i.workspace_id = $1::uuid
       AND EXISTS (SELECT 1 FROM active_access)
       AND i.deleted_at IS NULL
       AND c.status = 'active'
       AND (i.resource_id IS NULL OR (
         r.enabled = true AND r.acl_status = 'current'
         AND (c.provider NOT IN ('slack', 'linear', 'github') OR r.acl_synced_at > now() - interval '30 minutes')
       ))
       AND ($4::text IS NULL OR c.provider = $4::text)
       AND ($5::uuid IS NULL OR i.resource_id = $5::uuid)
       AND ${featureAuthorizationSql("$8", "c", "i")}
       AND ${connectorContentPolicySql("c", "i", "r")}
       AND (
         i.visibility = 'workspace' OR (
           i.visibility = 'restricted' AND i.acl_status = 'current' AND EXISTS (
             SELECT 1 FROM content_acl_entries a
             WHERE a.item_id = i.item_id AND ${contentAclSql("i", "a", "$2", "$7")}
           )
         )
       )
       AND (
         i.search_vector @@ q.exact OR
         (
           i.search_vector @@ q.broad AND
           (
             SELECT count(*) FROM unnest(q.terms) AS broad_term(value)
             WHERE i.search_vector @@ plainto_tsquery('simple', broad_term.value)
           ) >= LEAST(3, GREATEST(1, CEIL(cardinality(q.terms) * 0.6)::int))
         ) OR
         position(lower($3::text) in lower(i.title)) > 0 OR
         position(lower($3::text) in lower(i.body)) > 0
       )
     ORDER BY score DESC, i.source_updated_at DESC NULLS LAST, i.item_id
     LIMIT $6`,
    [
      input.workspaceId,
      principals,
      query,
      input.provider?.trim().toLowerCase() || null,
      input.resourceId?.trim() || null,
      limit,
      input.userId,
      input.permission ?? null,
      searchTsQuery(query),
      searchTerms(query),
    ],
  );
  return rows.map((row) => searchRow(row, query));
}

export async function getAuthorizedItemsByIds(input: {
  workspaceId: string;
  userId: string;
  itemIds: string[];
  permission?: Extract<WorkspacePermission, "search.use" | "chat.use">;
}): Promise<SearchResult[]> {
  const itemIds = [...new Set(input.itemIds)].slice(0, 100);
  if (itemIds.length === 0) return [];
  const principals = [...await userContentPrincipals(input.userId, input.workspaceId)];
  if (principals.length === 0) return [];
  const { rows } = await pool.query(
    `WITH active_access AS (
       SELECT membership.role
       FROM workspace_memberships membership
       JOIN users app_user ON app_user.user_id = membership.user_id
       WHERE membership.workspace_id = $1::uuid AND membership.user_id = $4::uuid
         AND membership.status = 'active' AND app_user.status = 'active'
     ), feature_grants AS (
       SELECT stored_grant.effect, stored_grant.conditions
       FROM permission_grants stored_grant
       CROSS JOIN active_access access
       WHERE stored_grant.workspace_id = $1::uuid AND stored_grant.permission = $5::text AND (
         (stored_grant.principal_type = 'role' AND stored_grant.principal_id = access.role) OR
         (stored_grant.principal_type = 'user' AND stored_grant.principal_id = $4::text) OR
         (stored_grant.principal_type = 'group' AND EXISTS (
           SELECT 1 FROM workspace_group_members membership
           WHERE membership.workspace_id = $1::uuid AND membership.user_id = $4::uuid
             AND membership.group_id::text = stored_grant.principal_id
         ))
       )
     )
     SELECT i.*, c.provider, 0::real AS score
     FROM content_items i
     JOIN connectors c ON c.connector_id = i.connector_id AND c.workspace_id = i.workspace_id
     LEFT JOIN connector_resources r ON r.resource_id = i.resource_id AND r.connector_id = i.connector_id
     WHERE i.workspace_id = $1::uuid
       AND EXISTS (SELECT 1 FROM active_access)
       AND i.item_id = ANY($2::uuid[])
       AND i.deleted_at IS NULL
       AND c.status = 'active'
       AND (i.resource_id IS NULL OR (
         r.enabled = true AND r.acl_status = 'current'
         AND (c.provider NOT IN ('slack', 'linear', 'github') OR r.acl_synced_at > now() - interval '30 minutes')
       ))
       AND ${featureAuthorizationSql("$5", "c", "i")}
       AND ${connectorContentPolicySql("c", "i", "r")}
       AND (
         i.visibility = 'workspace' OR (
           i.visibility = 'restricted' AND i.acl_status = 'current' AND EXISTS (
             SELECT 1 FROM content_acl_entries a
             WHERE a.item_id = i.item_id AND ${contentAclSql("i", "a", "$3", "$4")}
           )
         )
       )`,
    [input.workspaceId, itemIds, principals, input.userId, input.permission ?? null],
  );
  return rows.map((row) => searchRow(row, ""));
}

export async function authorizedMemberResourceIds(input: {
  workspaceId: string;
  userId: string;
  connectorId: string;
  resourceIds: string[];
}): Promise<Set<string>> {
  const resourceIds = [...new Set(input.resourceIds)].slice(0, 10_000);
  if (resourceIds.length === 0) return new Set();
  const principals = [...await userContentPrincipals(input.userId, input.workspaceId)];
  if (principals.length === 0) return new Set();
  const { rows } = await pool.query(
    `SELECT resource.resource_id
     FROM connector_resources resource
     JOIN connectors connector ON connector.connector_id = resource.connector_id
     WHERE connector.workspace_id = $1::uuid
       AND connector.connector_id = $2::uuid
       AND connector.status = 'active'
       AND resource.resource_id = ANY($3::uuid[])
       AND resource.enabled = true
       AND resource.acl_status = 'current'
       AND (
         connector.provider NOT IN ('slack', 'linear', 'github') OR
         resource.acl_synced_at > now() - interval '30 minutes'
       )
       AND EXISTS (
         SELECT 1 FROM connector_resource_memberships membership
         WHERE membership.workspace_id = connector.workspace_id
           AND membership.resource_id = resource.resource_id
           AND membership.principal = ANY($4::text[])
       )`,
    [input.workspaceId, input.connectorId, resourceIds, principals],
  );
  return new Set(rows.map((row) => String(row.resource_id)));
}

function policyFromRow(row: Record<string, unknown>): StoredConnectorPolicy {
  return {
    policyId: String(row.policy_id),
    workspaceId: String(row.workspace_id),
    connectorId: String(row.connector_id),
    effect: String(row.effect) as ContentPolicy["effect"],
    field: String(row.field) as ContentPolicyField,
    operator: String(row.operator) as ContentPolicyOperator,
    values: Array.isArray(row.values) ? row.values.map(String) : [],
    enabled: Boolean(row.enabled),
  };
}

export async function upsertConnectorPolicy(input: {
  policyId?: string;
  workspaceId: string;
  connectorId: string;
  effect: ContentPolicy["effect"];
  field: ContentPolicyField;
  operator: ContentPolicyOperator;
  values: string[];
  enabled?: boolean;
}): Promise<StoredConnectorPolicy> {
  if (!["include", "exclude"].includes(input.effect)) throw new Error("invalid policy effect");
  if (!CONTENT_POLICY_FIELDS.includes(input.field)) throw new Error("invalid policy field");
  if (!CONTENT_POLICY_OPERATORS.includes(input.operator)) throw new Error("invalid policy operator");
  const values = [...new Set(input.values.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
  if (values.length === 0) throw new Error("policy values are required");
  const { rows } = await pool.query(
    `INSERT INTO connector_policies
       (policy_id, workspace_id, connector_id, effect, field, operator, values, enabled)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
     WHERE EXISTS (
       SELECT 1 FROM connectors WHERE workspace_id = $2 AND connector_id = $3
     )
     ON CONFLICT (policy_id) DO UPDATE SET
       effect = EXCLUDED.effect,
       field = EXCLUDED.field,
       operator = EXCLUDED.operator,
       values = EXCLUDED.values,
       enabled = EXCLUDED.enabled,
       updated_at = now()
     WHERE connector_policies.workspace_id = EXCLUDED.workspace_id
       AND connector_policies.connector_id = EXCLUDED.connector_id
     RETURNING *`,
    [input.policyId ?? randomUUID(), input.workspaceId, input.connectorId, input.effect, input.field, input.operator, values, input.enabled ?? true],
  );
  if (!rows[0]) throw new Error("connector not found in workspace");
  return policyFromRow(rows[0]);
}

export async function listConnectorPolicies(workspaceId: string, connectorId?: string): Promise<StoredConnectorPolicy[]> {
  const { rows } = await pool.query(
    `SELECT * FROM connector_policies
     WHERE workspace_id = $1 AND ($2::uuid IS NULL OR connector_id = $2::uuid)
     ORDER BY connector_id, effect DESC, created_at`,
    [workspaceId, connectorId ?? null],
  );
  return rows.map(policyFromRow);
}

export async function getConnectorPolicy(workspaceId: string, policyId: string): Promise<StoredConnectorPolicy | null> {
  const { rows } = await pool.query(
    `SELECT * FROM connector_policies WHERE workspace_id = $1 AND policy_id = $2`,
    [workspaceId, policyId],
  );
  return rows[0] ? policyFromRow(rows[0]) : null;
}

export async function connectorContentAllowed(
  workspaceId: string,
  connectorId: string,
  target: ContentPolicyTarget,
): Promise<boolean> {
  return contentAllowed(await listConnectorPolicies(workspaceId, connectorId), target);
}

export async function deleteConnectorPolicy(workspaceId: string, policyId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM connector_policies WHERE workspace_id = $1 AND policy_id = $2`,
    [workspaceId, policyId],
  );
  return result.rowCount === 1;
}

function syncRunFromRow(row: Record<string, unknown>): ConnectorSyncRun {
  return {
    runId: String(row.run_id),
    workspaceId: String(row.workspace_id),
    connectorId: String(row.connector_id),
    status: String(row.status) as ConnectorSyncRun["status"],
    cursorValue: String(row.cursor_value ?? ""),
    itemsSeen: Number(row.items_seen ?? 0),
    itemsWritten: Number(row.items_written ?? 0),
    itemsDeleted: Number(row.items_deleted ?? 0),
    errorText: String(row.error_text ?? ""),
    startedAt: String(row.started_at),
    heartbeatAt: String(row.heartbeat_at ?? row.started_at),
    finishedAt: row.finished_at == null ? undefined : String(row.finished_at),
  };
}

export async function startConnectorSync(workspaceId: string, connectorId: string): Promise<ConnectorSyncRun> {
  const { rows } = await pool.query(
    `INSERT INTO connector_sync_runs (run_id, workspace_id, connector_id, status)
     SELECT $1, $2, $3, 'running'
     WHERE EXISTS (SELECT 1 FROM connectors WHERE workspace_id = $2 AND connector_id = $3)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [randomUUID(), workspaceId, connectorId],
  );
  if (!rows[0]) throw new Error("connector sync is already running or connector was not found");
  return syncRunFromRow(rows[0]);
}

export async function heartbeatConnectorSync(workspaceId: string, runId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE connector_sync_runs SET heartbeat_at = now()
     WHERE workspace_id = $1 AND run_id = $2 AND status = 'running'`,
    [workspaceId, runId],
  );
  return result.rowCount === 1;
}

export async function failStaleConnectorSyncs(maxAgeMinutes = 15): Promise<number> {
  const boundedAge = Math.max(15, Math.min(Math.floor(maxAgeMinutes), 24 * 60));
  const result = await pool.query(
    `UPDATE connector_sync_runs SET
       status = 'failed', error_text = 'sync worker stopped before completion', finished_at = now()
     WHERE status = 'running' AND heartbeat_at < now() - ($1::int * interval '1 minute')`,
    [boundedAge],
  );
  return result.rowCount ?? 0;
}

export async function finishConnectorSync(input: {
  workspaceId: string;
  runId: string;
  status: "succeeded" | "failed" | "partial";
  cursorValue?: string;
  itemsSeen?: number;
  itemsWritten?: number;
  itemsDeleted?: number;
  errorText?: string;
}): Promise<ConnectorSyncRun | null> {
  const count = (value?: number) => Math.max(0, Math.floor(value ?? 0));
  const { rows } = await pool.query(
    `UPDATE connector_sync_runs SET
       status = $3,
       cursor_value = $4,
       items_seen = $5,
       items_written = $6,
       items_deleted = $7,
       error_text = $8,
       heartbeat_at = now(),
       finished_at = now()
     WHERE workspace_id = $1 AND run_id = $2 AND status = 'running'
     RETURNING *`,
    [
      input.workspaceId, input.runId, input.status, input.cursorValue?.slice(0, 4000) ?? "",
      count(input.itemsSeen), count(input.itemsWritten), count(input.itemsDeleted), input.errorText?.slice(0, 2000) ?? "",
    ],
  );
  return rows[0] ? syncRunFromRow(rows[0]) : null;
}

export async function latestConnectorSyncs(workspaceId: string): Promise<ConnectorSyncRun[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (connector_id) * FROM connector_sync_runs
     WHERE workspace_id = $1
     ORDER BY connector_id, started_at DESC`,
    [workspaceId],
  );
  return rows.map(syncRunFromRow);
}

export async function latestSuccessfulConnectorCursor(connectorId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT cursor_value FROM connector_sync_runs
     WHERE connector_id = $1 AND status IN ('succeeded', 'partial') AND cursor_value <> ''
     ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    [connectorId],
  );
  return String(rows[0]?.cursor_value ?? "");
}

export async function markConnectorAclStale(workspaceId: string, connectorId: string): Promise<void> {
  await pool.query(
    `UPDATE content_items SET acl_status = 'stale'
     WHERE workspace_id = $1 AND connector_id = $2 AND visibility = 'restricted' AND deleted_at IS NULL`,
    [workspaceId, connectorId],
  );
}

export async function createChatExchange(input: {
  workspaceId: string;
  userId: string;
  threadId?: string;
  question: string;
  answer: string;
  citationItemIds: string[];
}): Promise<{ threadId: string; userMessageId: string; assistantMessageId: string }> {
  const question = cleanText(input.question, "question", 4000);
  const answer = cleanText(input.answer, "answer", 20_000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const threadId = input.threadId ?? randomUUID();
    if (input.threadId) {
      const thread = await client.query(
        `SELECT 1 FROM chat_threads WHERE thread_id = $1 AND workspace_id = $2 AND user_id = $3 FOR UPDATE`,
        [threadId, input.workspaceId, input.userId],
      );
      if (thread.rowCount !== 1) throw new Error("chat thread not found");
    } else {
      await client.query(
        `INSERT INTO chat_threads (thread_id, workspace_id, user_id, title) VALUES ($1, $2, $3, $4)`,
        [threadId, input.workspaceId, input.userId, question.slice(0, 120)],
      );
    }
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const citationItemIds = [...new Set(input.citationItemIds)].slice(0, 20);
    if (citationItemIds.length > 0) {
      const citationItems = await client.query(
        `SELECT count(*)::int AS count FROM content_items
         WHERE workspace_id = $1 AND item_id = ANY($2::uuid[])`,
        [input.workspaceId, citationItemIds],
      );
      if (Number(citationItems.rows[0]?.count ?? 0) !== citationItemIds.length) {
        throw new Error("chat citations do not belong to workspace");
      }
    }
    await client.query(
      `INSERT INTO chat_messages (message_id, thread_id, role, content) VALUES ($1, $2, 'user', $3)`,
      [userMessageId, threadId, question],
    );
    await client.query(
      `INSERT INTO chat_messages (message_id, thread_id, role, content) VALUES ($1, $2, 'assistant', $3)`,
      [assistantMessageId, threadId, answer],
    );
    for (const [index, itemId] of citationItemIds.entries()) {
      await client.query(
        `INSERT INTO chat_citations (message_id, item_id, ordinal) VALUES ($1, $2, $3)`,
        [assistantMessageId, itemId, index + 1],
      );
    }
    await client.query(`UPDATE chat_threads SET updated_at = now() WHERE thread_id = $1`, [threadId]);
    await client.query("COMMIT");
    return { threadId, userMessageId, assistantMessageId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listChatThreads(workspaceId: string, userId: string): Promise<Array<{
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}>> {
  const { rows } = await pool.query(
    `SELECT * FROM chat_threads WHERE workspace_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 100`,
    [workspaceId, userId],
  );
  return rows.map((row) => ({
    threadId: String(row.thread_id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function listAuthorizedChatMessages(
  workspaceId: string,
  userId: string,
  threadId: string,
  permission?: Extract<WorkspacePermission, "search.use" | "chat.use">,
): Promise<Array<{
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations: SearchResult[];
}>> {
  const thread = await pool.query(
    `SELECT 1 FROM chat_threads WHERE thread_id = $1 AND workspace_id = $2 AND user_id = $3`,
    [threadId, workspaceId, userId],
  );
  if (thread.rowCount !== 1) return [];
  const { rows } = await pool.query(
    `SELECT m.*, COALESCE(array_agg(c.item_id ORDER BY c.ordinal) FILTER (WHERE c.item_id IS NOT NULL), '{}') AS item_ids
     FROM chat_messages m
     LEFT JOIN chat_citations c ON c.message_id = m.message_id
     WHERE m.thread_id = $1
     GROUP BY m.message_id
     ORDER BY m.created_at, CASE m.role WHEN 'user' THEN 0 ELSE 1 END, m.message_id`,
    [threadId],
  );
  const messages = [];
  for (const row of rows) {
    const itemIds: string[] = Array.isArray(row.item_ids) ? row.item_ids.map(String) : [];
    const authorized = await getAuthorizedItemsByIds({ workspaceId, userId, itemIds, permission });
    const byItemId = new Map(authorized.map((item) => [item.itemId, item]));
    const citations = itemIds.map((itemId) => byItemId.get(itemId)).filter((item) => item !== undefined);
    const accessChanged = itemIds.length > 0 && citations.length !== itemIds.length;
    messages.push({
      messageId: String(row.message_id),
      role: String(row.role) as "user" | "assistant",
      content: accessChanged ? "This answer is unavailable because your source access changed." : String(row.content),
      createdAt: String(row.created_at),
      citations: accessChanged ? [] : citations,
    });
  }
  return messages;
}
