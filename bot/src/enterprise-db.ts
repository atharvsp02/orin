import { createHash, randomUUID } from "node:crypto";
import {
  can,
  isWorkspacePermission,
  isWorkspaceRole,
  normalizePrincipal,
  type GrantEffect,
  type GrantPrincipalType,
  type PermissionContext,
  type PermissionGrant,
  type WorkspacePermission,
  type WorkspaceRole,
} from "./access.js";
import { pool } from "./db.js";

export interface OrinUser {
  userId: string;
  displayName: string;
  primaryEmail: string;
  avatarUrl: string;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: "active" | "suspended";
  displayName?: string;
  primaryEmail?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceGroup {
  groupId: string;
  workspaceId: string;
  displayName: string;
  externalId?: string;
  memberCount: number;
  createdAt: string;
}

export interface StoredPermissionGrant extends PermissionGrant {
  grantId: string;
  workspaceId: string;
  principalType: GrantPrincipalType;
  principalId: string;
}

export interface WorkspaceAccess {
  user: OrinUser;
  membership: WorkspaceMembership;
  grants: StoredPermissionGrant[];
}

export interface AuditEvent {
  eventId: string;
  workspaceId: string;
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: "success" | "denied" | "failure";
  requestId: string;
  ipHash: string;
  details: Record<string, unknown>;
  createdAt: string;
}

function userFromRow(row: Record<string, unknown>): OrinUser {
  return {
    userId: String(row.user_id),
    displayName: String(row.display_name),
    primaryEmail: String(row.primary_email ?? ""),
    avatarUrl: String(row.avatar_url ?? ""),
    status: String(row.status) as OrinUser["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function membershipFromRow(row: Record<string, unknown>): WorkspaceMembership {
  return {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    role: String(row.role) as WorkspaceRole,
    status: String(row.membership_status ?? row.status) as WorkspaceMembership["status"],
    displayName: row.display_name == null ? undefined : String(row.display_name),
    primaryEmail: row.primary_email == null ? undefined : String(row.primary_email),
    avatarUrl: row.avatar_url == null ? undefined : String(row.avatar_url),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function stableUserId(provider: string, externalId: string): string {
  const hex = createHash("md5").update(`orin-user:${provider}:${externalId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cleanProvider(value: string): string {
  const provider = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new Error("invalid identity provider");
  return provider;
}

function cleanExternalId(value: string): string {
  const externalId = value.trim();
  if (!externalId || externalId.length > 320) throw new Error("invalid external identity");
  return externalId;
}

function cleanEmail(value?: string): string {
  const email = value?.trim().toLowerCase() ?? "";
  if (email && (!email.includes("@") || email.length > 320)) throw new Error("invalid email");
  return email;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseConditions(value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: Record<string, string | string[]> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") parsed[key] = item;
    if (Array.isArray(item) && item.every((part) => typeof part === "string")) parsed[key] = item as string[];
  }
  return parsed;
}

function grantFromRow(row: Record<string, unknown>): StoredPermissionGrant {
  return {
    grantId: String(row.grant_id),
    workspaceId: String(row.workspace_id),
    principalType: String(row.principal_type) as GrantPrincipalType,
    principalId: String(row.principal_id),
    permission: String(row.permission) as WorkspacePermission,
    effect: String(row.effect) as GrantEffect,
    conditions: parseConditions(row.conditions),
  };
}

export async function upsertUserIdentity(input: {
  provider: string;
  externalId: string;
  handle?: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  reactivate?: boolean;
}): Promise<OrinUser> {
  const provider = cleanProvider(input.provider);
  const externalId = cleanExternalId(input.externalId);
  const email = cleanEmail(input.email);
  const displayName = input.displayName.trim().slice(0, 160) || input.handle?.trim().slice(0, 160) || "Orin user";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const identity = await client.query(
      `SELECT user_id FROM user_identities WHERE provider = $1 AND external_id = $2 FOR UPDATE`,
      [provider, externalId],
    );
    let userId = identity.rows[0]?.user_id ? String(identity.rows[0].user_id) : "";
    if (!userId && email) {
      const byEmail = await client.query(`SELECT user_id FROM users WHERE lower(primary_email) = $1 FOR UPDATE`, [email]);
      userId = byEmail.rows[0]?.user_id ? String(byEmail.rows[0].user_id) : "";
    }
    userId ||= stableUserId(provider, externalId);
    await client.query(
      `INSERT INTO users (user_id, display_name, primary_email, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         primary_email = CASE WHEN EXCLUDED.primary_email <> '' THEN EXCLUDED.primary_email ELSE users.primary_email END,
         avatar_url = CASE WHEN EXCLUDED.avatar_url <> '' THEN EXCLUDED.avatar_url ELSE users.avatar_url END,
         status = CASE WHEN $5 THEN 'active' ELSE users.status END,
         updated_at = now()`,
      [userId, displayName, email, input.avatarUrl?.trim().slice(0, 1000) ?? "", input.reactivate ?? true],
    );
    await client.query(
      `INSERT INTO user_identities (provider, external_id, user_id, handle, email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, external_id) DO UPDATE SET
         handle = EXCLUDED.handle,
         email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE user_identities.email END,
         updated_at = now()`,
      [provider, externalId, userId, input.handle?.trim().slice(0, 160) ?? "", email],
    );
    const result = await client.query(
      `SELECT u.* FROM users u
       JOIN user_identities i ON i.user_id = u.user_id
       WHERE i.provider = $1 AND i.external_id = $2`,
      [provider, externalId],
    );
    await client.query("COMMIT");
    return userFromRow(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addUserIdentity(userId: string, input: {
  provider: string;
  externalId: string;
  handle?: string;
  email?: string;
}): Promise<void> {
  const provider = cleanProvider(input.provider);
  const externalId = cleanExternalId(input.externalId);
  const result = await pool.query(
    `INSERT INTO user_identities (provider, external_id, user_id, handle, email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, external_id) DO UPDATE SET
       handle = EXCLUDED.handle,
       email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE user_identities.email END,
       updated_at = now()
     WHERE user_identities.user_id = EXCLUDED.user_id
     RETURNING user_id`,
    [provider, externalId, userId, input.handle?.trim().slice(0, 160) ?? "", cleanEmail(input.email)],
  );
  if (result.rowCount !== 1) throw new Error("identity is already linked to another user");
}

export async function getUser(userId: string): Promise<OrinUser | null> {
  const { rows } = await pool.query(`SELECT * FROM users WHERE user_id = $1`, [userId]);
  return rows[0] ? userFromRow(rows[0]) : null;
}

export async function getUserByIdentity(provider: string, externalId: string): Promise<OrinUser | null> {
  const { rows } = await pool.query(
    `SELECT u.* FROM users u
     JOIN user_identities i ON i.user_id = u.user_id
     WHERE i.provider = $1 AND i.external_id = $2`,
    [cleanProvider(provider), cleanExternalId(externalId)],
  );
  return rows[0] ? userFromRow(rows[0]) : null;
}

export async function bootstrapWorkspaceMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(`SELECT 1 FROM workspaces WHERE workspace_id = $1 FOR UPDATE`, [workspaceId]);
    if (workspace.rowCount !== 1) throw new Error("workspace not found");
    const { rows: countRows } = await client.query(
      `SELECT count(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1 AND status = 'active'`,
      [workspaceId],
    );
    const initialRole: WorkspaceRole = Number(countRows[0]?.count ?? 0) === 0 ? "owner" : "admin";
    const { rows } = await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET updated_at = workspace_memberships.updated_at
       RETURNING *, status AS membership_status`,
      [workspaceId, userId, initialRole],
    );
    await client.query("COMMIT");
    return membershipFromRow(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimUnownedWorkspace(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(`SELECT 1 FROM workspaces WHERE workspace_id = $1 FOR UPDATE`, [workspaceId]);
    if (workspace.rowCount !== 1) throw new Error("workspace not found");
    const activeMembers = await client.query(
      `SELECT count(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1 AND status = 'active'`,
      [workspaceId],
    );
    if (Number(activeMembers.rows[0]?.count ?? 0) !== 0) {
      await client.query("COMMIT");
      return null;
    }
    const { rows } = await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       SELECT $1, user_id, 'owner' FROM users WHERE user_id = $2 AND status = 'active'
       ON CONFLICT (workspace_id, user_id) DO NOTHING
       RETURNING *, status AS membership_status`,
      [workspaceId, userId],
    );
    await client.query("COMMIT");
    return rows[0] ? membershipFromRow(rows[0]) : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listUserWorkspaces(userId: string): Promise<Array<{
  workspaceId: string;
  displayName: string;
  legacyInstallationId?: number;
  role: WorkspaceRole;
  decisions: number;
}>> {
  const { rows } = await pool.query(
    `SELECT w.workspace_id, w.display_name, w.legacy_installation_id, m.role,
            CASE WHEN w.legacy_installation_id IS NULL THEN 0 ELSE
              (SELECT count(*)::int FROM decision_records d WHERE d.installation_id = w.legacy_installation_id)
            END AS decisions
     FROM workspace_memberships m
     JOIN workspaces w ON w.workspace_id = m.workspace_id
     JOIN users u ON u.user_id = m.user_id
     WHERE m.user_id = $1 AND m.status = 'active' AND u.status = 'active'
     ORDER BY w.display_name`,
    [userId],
  );
  return rows.map((row) => ({
    workspaceId: String(row.workspace_id),
    displayName: String(row.display_name),
    legacyInstallationId: row.legacy_installation_id == null ? undefined : Number(row.legacy_installation_id),
    role: String(row.role) as WorkspaceRole,
    decisions: Number(row.decisions ?? 0),
  }));
}

export async function getWorkspaceAccess(userId: string, workspaceId: string): Promise<WorkspaceAccess | null> {
  const { rows } = await pool.query(
    `SELECT u.*, m.role, m.status AS membership_status, m.created_at AS membership_created_at,
            m.updated_at AS membership_updated_at
     FROM users u
     JOIN workspace_memberships m ON m.user_id = u.user_id
     WHERE u.user_id = $1 AND m.workspace_id = $2 AND u.status = 'active' AND m.status = 'active'`,
    [userId, workspaceId],
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const membership = membershipFromRow({
    workspace_id: workspaceId,
    user_id: userId,
    role: row.role,
    membership_status: row.membership_status,
    created_at: row.membership_created_at,
    updated_at: row.membership_updated_at,
  });
  const grants = await listApplicableGrants(workspaceId, userId, membership.role);
  return { user: userFromRow(row), membership, grants };
}

export async function listApplicableGrants(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<StoredPermissionGrant[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT g.*
     FROM permission_grants g
     WHERE g.workspace_id = $1::uuid AND (
       (g.principal_type = 'role' AND g.principal_id = $3) OR
       (g.principal_type = 'user' AND g.principal_id = $2::text) OR
       (g.principal_type = 'group' AND EXISTS (
         SELECT 1 FROM workspace_group_members gm
         WHERE gm.workspace_id = $1::uuid AND gm.user_id = $2::uuid AND gm.group_id::text = g.principal_id
       ))
     )`,
    [workspaceId, userId, role],
  );
  return rows.filter((row) => isWorkspacePermission(row.permission)).map(grantFromRow);
}

export async function userCan(
  userId: string,
  workspaceId: string,
  permission: WorkspacePermission,
  context: PermissionContext = {},
): Promise<boolean> {
  const access = await getWorkspaceAccess(userId, workspaceId);
  return access ? can(access.membership.role, permission, access.grants, context) : false;
}

export async function listMemberships(workspaceId: string): Promise<WorkspaceMembership[]> {
  const { rows } = await pool.query(
    `SELECT m.*, m.status AS membership_status, u.display_name, u.primary_email, u.avatar_url
     FROM workspace_memberships m
     JOIN users u ON u.user_id = m.user_id
     WHERE m.workspace_id = $1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
              lower(u.display_name)`,
    [workspaceId],
  );
  return rows.map(membershipFromRow);
}

export async function getWorkspaceMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
  const { rows } = await pool.query(
    `SELECT m.*, m.status AS membership_status, u.display_name, u.primary_email, u.avatar_url
     FROM workspace_memberships m
     JOIN users u ON u.user_id = m.user_id
     WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  return rows[0] ? membershipFromRow(rows[0]) : null;
}

export async function inviteWorkspaceMember(input: {
  workspaceId: string;
  email: string;
  displayName?: string;
  role: WorkspaceRole;
  allowOwnerChange?: boolean;
}): Promise<WorkspaceMembership> {
  if (!isWorkspaceRole(input.role)) throw new Error("invalid workspace role");
  const email = cleanEmail(input.email);
  if (!email) throw new Error("email is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(`SELECT 1 FROM workspaces WHERE workspace_id = $1 FOR UPDATE`, [input.workspaceId]);
    if (workspace.rowCount !== 1) throw new Error("workspace not found");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`orin-invite:${email}`]);
    const existingUser = await client.query(
      `SELECT user_id FROM users WHERE lower(primary_email) = $1 FOR UPDATE`,
      [email],
    );
    const userId = existingUser.rows[0]?.user_id
      ? String(existingUser.rows[0].user_id)
      : stableUserId("email", email);
    const existing = await client.query(
      `SELECT role, status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
      [input.workspaceId, userId],
    );
    const current = existing.rows[0] as { role?: string; status?: string } | undefined;
    if ((current?.role === "owner" || input.role === "owner") && !input.allowOwnerChange) {
      throw new Error("only an owner can change owner access");
    }
    if (current?.role === "owner" && current.status === "active" && input.role !== "owner") {
      const owners = await client.query(
        `SELECT count(*)::int AS count FROM workspace_memberships
         WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'`,
        [input.workspaceId],
      );
      if (Number(owners.rows[0]?.count ?? 0) <= 1) throw new Error("a workspace must keep at least one active owner");
    }
    if (existingUser.rowCount === 0) {
      await client.query(
        `INSERT INTO users (user_id, display_name, primary_email)
         VALUES ($1, $2, $3)`,
        [userId, input.displayName?.trim().slice(0, 160) || email.split("@")[0], email],
      );
    }
    const identity = await client.query(
      `INSERT INTO user_identities (provider, external_id, user_id, handle, email)
       VALUES ('email', $1, $2, $1, $1)
       ON CONFLICT (provider, external_id) DO UPDATE SET updated_at = now()
       WHERE user_identities.user_id = EXCLUDED.user_id
       RETURNING user_id`,
      [email, userId],
    );
    if (identity.rowCount !== 1) throw new Error("identity is already linked to another user");
    const { rows } = await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()
       RETURNING *, status AS membership_status`,
      [input.workspaceId, userId, input.role],
    );
    await client.query("COMMIT");
    return membershipFromRow(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
  role?: WorkspaceRole;
  status?: "active" | "suspended";
  allowOwnerChange?: boolean;
}): Promise<WorkspaceMembership | null> {
  if (input.role !== undefined && !isWorkspaceRole(input.role)) throw new Error("invalid workspace role");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(`SELECT 1 FROM workspaces WHERE workspace_id = $1 FOR UPDATE`, [input.workspaceId]);
    if (workspace.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const current = await client.query(
      `SELECT * FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
      [input.workspaceId, input.userId],
    );
    if (current.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = current.rows[0] as { role: WorkspaceRole; status: "active" | "suspended" };
    const nextRole = input.role ?? row.role;
    const nextStatus = input.status ?? row.status;
    if ((row.role === "owner" || nextRole === "owner") && !input.allowOwnerChange) {
      throw new Error("only an owner can change owner access");
    }
    if (row.role === "owner" && row.status === "active" && (nextRole !== "owner" || nextStatus !== "active")) {
      const owners = await client.query(
        `SELECT count(*)::int AS count FROM workspace_memberships
         WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'`,
        [input.workspaceId],
      );
      if (Number(owners.rows[0]?.count ?? 0) <= 1) throw new Error("a workspace must keep at least one active owner");
    }
    const { rows } = await client.query(
      `UPDATE workspace_memberships
       SET role = $3, status = $4, updated_at = now()
       WHERE workspace_id = $1 AND user_id = $2
       RETURNING *, status AS membership_status`,
      [input.workspaceId, input.userId, nextRole, nextStatus],
    );
    await client.query("COMMIT");
    return membershipFromRow(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function countActiveOwners(workspaceId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM workspace_memberships
     WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'`,
    [workspaceId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function createGroup(input: {
  workspaceId: string;
  displayName: string;
  externalId?: string;
}): Promise<WorkspaceGroup> {
  const displayName = input.displayName.trim().slice(0, 160);
  if (!displayName) throw new Error("group name is required");
  const externalId = input.externalId?.trim().toLowerCase().slice(0, 320) || null;
  const { rows } = await pool.query(
    `INSERT INTO workspace_groups (group_id, workspace_id, display_name, external_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *, 0::int AS member_count`,
    [randomUUID(), input.workspaceId, displayName, externalId],
  );
  return groupFromRow(rows[0]);
}

function groupFromRow(row: Record<string, unknown>): WorkspaceGroup {
  return {
    groupId: String(row.group_id),
    workspaceId: String(row.workspace_id),
    displayName: String(row.display_name),
    externalId: row.external_id == null ? undefined : String(row.external_id),
    memberCount: Number(row.member_count ?? 0),
    createdAt: String(row.created_at),
  };
}

export async function listGroups(workspaceId: string): Promise<WorkspaceGroup[]> {
  const { rows } = await pool.query(
    `SELECT g.*, count(gm.user_id)::int AS member_count
     FROM workspace_groups g
     LEFT JOIN workspace_group_members gm ON gm.group_id = g.group_id
     WHERE g.workspace_id = $1
     GROUP BY g.group_id
     ORDER BY lower(g.display_name)`,
    [workspaceId],
  );
  return rows.map(groupFromRow);
}

export async function deleteGroup(workspaceId: string, groupId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const group = await client.query(
      `SELECT 1 FROM workspace_groups WHERE workspace_id = $1 AND group_id = $2 FOR UPDATE`,
      [workspaceId, groupId],
    );
    if (group.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `DELETE FROM permission_grants
       WHERE workspace_id = $1 AND principal_type = 'group' AND principal_id = $2::text`,
      [workspaceId, groupId],
    );
    const result = await client.query(
      `DELETE FROM workspace_groups WHERE workspace_id = $1 AND group_id = $2`,
      [workspaceId, groupId],
    );
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceGroupMembers(workspaceId: string, groupId: string, userIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length > 1000) throw new Error("group membership exceeds 1000 users");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const group = await client.query(
      `SELECT 1 FROM workspace_groups WHERE workspace_id = $1 AND group_id = $2 FOR UPDATE`,
      [workspaceId, groupId],
    );
    if (group.rowCount !== 1) throw new Error("group not found");
    await client.query(`DELETE FROM workspace_group_members WHERE workspace_id = $1 AND group_id = $2`, [workspaceId, groupId]);
    for (const userId of uniqueIds) {
      await client.query(
        `INSERT INTO workspace_group_members (workspace_id, group_id, user_id) VALUES ($1, $2, $3)`,
        [workspaceId, groupId, userId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listGroupMemberIds(workspaceId: string, groupId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT user_id FROM workspace_group_members WHERE workspace_id = $1 AND group_id = $2 ORDER BY user_id`,
    [workspaceId, groupId],
  );
  return rows.map((row) => String(row.user_id));
}

export async function upsertPermissionGrant(input: {
  grantId?: string;
  workspaceId: string;
  principalType: GrantPrincipalType;
  principalId: string;
  permission: WorkspacePermission;
  effect: GrantEffect;
  conditions?: Record<string, string | string[]>;
}): Promise<StoredPermissionGrant> {
  if (!["role", "user", "group"].includes(input.principalType)) throw new Error("invalid grant principal");
  if (!isWorkspacePermission(input.permission)) throw new Error("invalid permission");
  if (!["allow", "deny"].includes(input.effect)) throw new Error("invalid grant effect");
  const principalId = input.principalId.trim().toLowerCase();
  if (!principalId) throw new Error("grant principal id is required");
  if (input.principalType === "role" && !isWorkspaceRole(principalId)) throw new Error("invalid grant role");
  if (input.principalType !== "role" && !UUID_PATTERN.test(principalId)) throw new Error("invalid grant principal id");
  const conditions = parseConditions(input.conditions);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.principalType === "user") {
      const member = await client.query(
        `SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 FOR SHARE`,
        [input.workspaceId, principalId],
      );
      if (member.rowCount !== 1) throw new Error("grant user is not a workspace member");
    }
    if (input.principalType === "group") {
      const group = await client.query(
        `SELECT 1 FROM workspace_groups WHERE workspace_id = $1 AND group_id = $2 FOR SHARE`,
        [input.workspaceId, principalId],
      );
      if (group.rowCount !== 1) throw new Error("grant group not found");
    }
    const { rows } = await client.query(
      `INSERT INTO permission_grants
         (grant_id, workspace_id, principal_type, principal_id, permission, effect, conditions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, principal_type, principal_id, permission, conditions) DO UPDATE SET
         effect = EXCLUDED.effect, updated_at = now()
       RETURNING *`,
      [input.grantId ?? randomUUID(), input.workspaceId, input.principalType, principalId, input.permission, input.effect, conditions],
    );
    await client.query("COMMIT");
    return grantFromRow(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPermissionGrants(workspaceId: string): Promise<StoredPermissionGrant[]> {
  const { rows } = await pool.query(
    `SELECT * FROM permission_grants WHERE workspace_id = $1 ORDER BY principal_type, principal_id, permission`,
    [workspaceId],
  );
  return rows.filter((row) => isWorkspacePermission(row.permission)).map(grantFromRow);
}

export async function getPermissionGrant(workspaceId: string, grantId: string): Promise<StoredPermissionGrant | null> {
  const { rows } = await pool.query(
    `SELECT * FROM permission_grants WHERE workspace_id = $1 AND grant_id = $2`,
    [workspaceId, grantId],
  );
  return rows[0] && isWorkspacePermission(rows[0].permission) ? grantFromRow(rows[0]) : null;
}

export async function deletePermissionGrant(workspaceId: string, grantId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM permission_grants WHERE workspace_id = $1 AND grant_id = $2`,
    [workspaceId, grantId],
  );
  return result.rowCount === 1;
}

export async function userContentPrincipals(userId: string, workspaceId: string): Promise<Set<string>> {
  const access = await getWorkspaceAccess(userId, workspaceId);
  if (!access) return new Set();
  const principals = new Set<string>([normalizePrincipal("user", userId), normalizePrincipal("anyone", "*")]);
  const { rows: identities } = await pool.query(
    `SELECT provider, external_id, email FROM user_identities WHERE user_id = $1`,
    [userId],
  );
  const emails = new Set<string>();
  if (access.user.primaryEmail) emails.add(access.user.primaryEmail.toLowerCase());
  for (const identity of identities) {
    principals.add(normalizePrincipal(String(identity.provider), String(identity.external_id)));
    if (identity.email) emails.add(String(identity.email).toLowerCase());
  }
  for (const email of emails) {
    principals.add(normalizePrincipal("email", email));
    const domain = email.split("@")[1];
    if (domain) principals.add(normalizePrincipal("domain", domain));
  }
  const { rows: groups } = await pool.query(
    `SELECT g.group_id, g.external_id
     FROM workspace_group_members gm
     JOIN workspace_groups g ON g.group_id = gm.group_id
     WHERE gm.workspace_id = $1 AND gm.user_id = $2`,
    [workspaceId, userId],
  );
  for (const group of groups) {
    principals.add(normalizePrincipal("group", String(group.group_id)));
    if (group.external_id) principals.add(normalizePrincipal("external_group", String(group.external_id)));
  }
  return principals;
}

export async function recordAuditEvent(input: {
  workspaceId: string;
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome?: AuditEvent["outcome"];
  requestId?: string;
  ipHash?: string;
  details?: Record<string, unknown>;
}): Promise<AuditEvent> {
  const action = input.action.trim().slice(0, 120);
  const targetType = input.targetType.trim().slice(0, 80);
  const targetId = input.targetId.trim().slice(0, 320);
  if (!action || !targetType || !targetId) throw new Error("invalid audit event");
  const { rows } = await pool.query(
    `INSERT INTO audit_events
       (event_id, workspace_id, actor_user_id, action, target_type, target_id, outcome, request_id, ip_hash, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      randomUUID(), input.workspaceId, input.actorUserId ?? null, action, targetType, targetId,
      input.outcome ?? "success", input.requestId?.slice(0, 160) ?? "", input.ipHash?.slice(0, 128) ?? "",
      input.details ?? {},
    ],
  );
  return auditFromRow(rows[0]);
}

function auditFromRow(row: Record<string, unknown>): AuditEvent {
  return {
    eventId: String(row.event_id),
    workspaceId: String(row.workspace_id),
    actorUserId: row.actor_user_id == null ? undefined : String(row.actor_user_id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    outcome: String(row.outcome) as AuditEvent["outcome"],
    requestId: String(row.request_id ?? ""),
    ipHash: String(row.ip_hash ?? ""),
    details: row.details && typeof row.details === "object" ? row.details as Record<string, unknown> : {},
    createdAt: String(row.created_at),
  };
}

export async function listAuditEvents(workspaceId: string, limit = 100): Promise<AuditEvent[]> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 200));
  const { rows } = await pool.query(
    `SELECT * FROM audit_events WHERE workspace_id = $1 ORDER BY created_at DESC, event_id DESC LIMIT $2`,
    [workspaceId, boundedLimit],
  );
  return rows.map(auditFromRow);
}

export async function consumeRateLimit(input: {
  workspaceId: string;
  userId: string;
  action: string;
  limit: number;
  windowSeconds?: number;
}): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const windowSeconds = Math.max(10, Math.min(Math.floor(input.windowSeconds ?? 60), 3600));
  const limit = Math.max(1, Math.min(Math.floor(input.limit), 10_000));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const expiresAt = new Date(((bucket + 1) * windowSeconds + 3600) * 1000).toISOString();
  const { rows } = await pool.query(
    `INSERT INTO request_rate_limits (workspace_id, user_id, action, bucket, request_count, expires_at)
     VALUES ($1, $2, $3, $4, 1, $5)
     ON CONFLICT (workspace_id, user_id, action, bucket) DO UPDATE SET
       request_count = request_rate_limits.request_count + 1,
       expires_at = GREATEST(request_rate_limits.expires_at, EXCLUDED.expires_at)
     RETURNING request_count`,
    [input.workspaceId, input.userId, input.action.trim().slice(0, 80), bucket, expiresAt],
  );
  const count = Number(rows[0].request_count);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: windowSeconds - nowSeconds % windowSeconds,
  };
}

export async function pruneExpiredRateLimits(): Promise<number> {
  const result = await pool.query(`DELETE FROM request_rate_limits WHERE expires_at < now()`);
  return result.rowCount ?? 0;
}
