export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;
export const WORKSPACE_PERMISSIONS = [
  "workspace.read",
  "search.use",
  "chat.use",
  "connectors.read",
  "connectors.manage",
  "content.manage",
  "people.manage",
  "policies.manage",
  "settings.manage",
  "audit.read",
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];
export type GrantEffect = "allow" | "deny";
export type GrantPrincipalType = "role" | "user" | "group";

export interface PermissionContext {
  connectorProvider?: string;
  resourceId?: string;
  sourceType?: string;
}

export interface PermissionGrant {
  permission: WorkspacePermission;
  effect: GrantEffect;
  conditions?: Record<string, string | string[]>;
}

export interface ContentAccessInput {
  visibility: "workspace" | "restricted";
  aclStatus: "current" | "stale" | "failed";
  aclPrincipals: readonly string[];
}

const rolePermissions: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  owner: new Set(WORKSPACE_PERMISSIONS),
  admin: new Set(WORKSPACE_PERMISSIONS),
  member: new Set(["workspace.read", "search.use", "chat.use", "connectors.read"]),
  viewer: new Set(["workspace.read", "search.use", "connectors.read"]),
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && WORKSPACE_ROLES.includes(value as WorkspaceRole);
}

export function isWorkspacePermission(value: unknown): value is WorkspacePermission {
  return typeof value === "string" && WORKSPACE_PERMISSIONS.includes(value as WorkspacePermission);
}

export function normalizePrincipal(type: string, key: string): string {
  const normalizedType = type.trim().toLowerCase();
  const normalizedKey = key.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalizedType)) throw new Error("invalid principal type");
  if (!normalizedKey || normalizedKey.length > 320) throw new Error("invalid principal key");
  return `${normalizedType}:${normalizedKey}`;
}

export function matchesConditions(
  conditions: Record<string, string | string[]> | undefined,
  context: PermissionContext,
): boolean {
  if (!conditions || Object.keys(conditions).length === 0) return true;
  const values: Record<string, string | undefined> = {
    connectorProvider: context.connectorProvider?.trim().toLowerCase(),
    resourceId: context.resourceId?.trim().toLowerCase(),
    sourceType: context.sourceType?.trim().toLowerCase(),
  };
  return Object.entries(conditions).every(([key, expected]) => {
    const actual = values[key];
    if (actual === undefined) return false;
    const candidates = (Array.isArray(expected) ? expected : [expected]).map((item) => item.trim().toLowerCase());
    return candidates.includes(actual);
  });
}

export function can(
  role: WorkspaceRole,
  permission: WorkspacePermission,
  grants: readonly PermissionGrant[] = [],
  context: PermissionContext = {},
): boolean {
  const applicable = grants.filter(
    (grant) => grant.permission === permission && matchesConditions(grant.conditions, context),
  );
  if (applicable.some((grant) => grant.effect === "deny")) return false;
  if (applicable.some((grant) => grant.effect === "allow")) return true;
  return rolePermissions[role].has(permission);
}

export function canAccessContent(input: ContentAccessInput, principals: ReadonlySet<string>): boolean {
  if (input.visibility === "workspace") return true;
  if (input.aclStatus !== "current" || input.aclPrincipals.length === 0) return false;
  return input.aclPrincipals.some((principal) => principals.has(principal.toLowerCase()));
}

