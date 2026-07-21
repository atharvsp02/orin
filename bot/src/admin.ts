import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isWorkspacePermission,
  isWorkspaceRole,
  type GrantEffect,
  type GrantPrincipalType,
  type WorkspaceRole,
} from "./access.js";
import { send } from "./auth.js";
import { config } from "./config.js";
import * as enterprise from "./enterprise-db.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readBody(req: IncomingMessage, limit = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length > limit) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function requestMetadata(req: IncomingMessage): { requestId: string; ipHash: string } {
  const requestId = String(req.headers["x-request-id"] ?? randomUUID()).slice(0, 160);
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const address = forwarded || req.socket.remoteAddress || "unknown";
  const ipHash = createHash("sha256").update(`${config.secret}:audit:${address}`).digest("hex");
  return { requestId, ipHash };
}

async function audit(
  req: IncomingMessage,
  workspaceId: string,
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await enterprise.recordAuditEvent({
    workspaceId,
    actorUserId,
    action,
    targetType,
    targetId,
    details,
    ...requestMetadata(req),
  });
}

function parseConditions(value: unknown): Record<string, string | string[]> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(["connectorProvider", "resourceId", "sourceType"]);
  const conditions: Record<string, string | string[]> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) return null;
    if (typeof item === "string" && item.trim()) conditions[key] = item.trim().slice(0, 320);
    else if (Array.isArray(item) && item.length > 0 && item.length <= 50 && item.every((part) => typeof part === "string" && part.trim())) {
      conditions[key] = item.map((part) => String(part).trim().slice(0, 320));
    } else return null;
  }
  return conditions;
}

async function targetIsOwner(workspaceId: string, userId: string): Promise<boolean> {
  return (await enterprise.listMemberships(workspaceId)).some(
    (membership) => membership.userId === userId && membership.role === "owner" && membership.status === "active",
  );
}

export async function handleWorkspaceAdmin(input: {
  req: IncomingMessage;
  res: ServerResponse;
  workspaceId: string;
  actorUserId: string;
  resource: string;
  sub?: string;
}): Promise<boolean> {
  const { req, res, workspaceId, actorUserId, resource, sub } = input;
  if (!["people", "groups", "policies", "audit"].includes(resource)) return false;
  const access = await enterprise.getWorkspaceAccess(actorUserId, workspaceId);
  if (!access) {
    send(res, 403, { error: "workspace membership required" });
    return true;
  }

  if (resource === "people" && req.method === "GET" && !sub) {
    send(res, 200, { people: await enterprise.listMemberships(workspaceId) });
    return true;
  }

  if (resource === "people" && req.method === "POST" && !sub) {
    const body = await jsonBody(req);
    const role = body?.role;
    if (!body || typeof body.email !== "string" || !isWorkspaceRole(role)) {
      send(res, 400, { error: "email and valid role are required" });
      return true;
    }
    if (role === "owner" && access.membership.role !== "owner") {
      send(res, 403, { error: "only an owner can add another owner" });
      return true;
    }
    try {
      const membership = await enterprise.inviteWorkspaceMember({
        workspaceId,
        email: body.email,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        role,
      });
      await audit(req, workspaceId, actorUserId, "membership.invited", "user", membership.userId, { role });
      send(res, 201, membership);
    } catch (error) {
      send(res, 400, { error: (error as Error).message });
    }
    return true;
  }

  if (resource === "people" && req.method === "PUT" && sub) {
    if (!UUID_PATTERN.test(sub)) {
      send(res, 400, { error: "invalid user id" });
      return true;
    }
    const body = await jsonBody(req);
    const role = body?.role;
    const status = body?.status;
    if (!body || (role !== undefined && !isWorkspaceRole(role)) || (status !== undefined && status !== "active" && status !== "suspended")) {
      send(res, 400, { error: "valid role or status is required" });
      return true;
    }
    const ownerTarget = await targetIsOwner(workspaceId, sub);
    if ((ownerTarget || role === "owner") && access.membership.role !== "owner") {
      send(res, 403, { error: "only an owner can change owner access" });
      return true;
    }
    const removesOwner = ownerTarget && (role !== undefined && role !== "owner" || status === "suspended");
    if (removesOwner && await enterprise.countActiveOwners(workspaceId) <= 1) {
      send(res, 409, { error: "a workspace must keep at least one active owner" });
      return true;
    }
    const membership = await enterprise.updateWorkspaceMember({
      workspaceId,
      userId: sub,
      role: role as WorkspaceRole | undefined,
      status: status as "active" | "suspended" | undefined,
    });
    if (!membership) {
      send(res, 404, { error: "member not found" });
      return true;
    }
    await audit(req, workspaceId, actorUserId, "membership.updated", "user", sub, {
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
    });
    send(res, 200, membership);
    return true;
  }

  if (resource === "groups" && req.method === "GET" && !sub) {
    const groups = await enterprise.listGroups(workspaceId);
    send(res, 200, {
      groups: await Promise.all(groups.map(async (group) => ({
        ...group,
        memberIds: await enterprise.listGroupMemberIds(workspaceId, group.groupId),
      }))),
    });
    return true;
  }

  if (resource === "groups" && req.method === "POST" && !sub) {
    const body = await jsonBody(req);
    if (!body || typeof body.displayName !== "string") {
      send(res, 400, { error: "group name is required" });
      return true;
    }
    try {
      const group = await enterprise.createGroup({
        workspaceId,
        displayName: body.displayName,
        externalId: typeof body.externalId === "string" ? body.externalId : undefined,
      });
      await audit(req, workspaceId, actorUserId, "group.created", "group", group.groupId, { displayName: group.displayName });
      send(res, 201, group);
    } catch (error) {
      send(res, 409, { error: (error as Error).message });
    }
    return true;
  }

  if (resource === "groups" && req.method === "PUT" && sub) {
    const body = await jsonBody(req);
    if (!UUID_PATTERN.test(sub) || !body || !Array.isArray(body.userIds) || !body.userIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
      send(res, 400, { error: "valid group and user ids are required" });
      return true;
    }
    try {
      await enterprise.replaceGroupMembers(workspaceId, sub, body.userIds as string[]);
      await audit(req, workspaceId, actorUserId, "group.members_replaced", "group", sub, { memberCount: body.userIds.length });
      send(res, 200, { groupId: sub, memberIds: await enterprise.listGroupMemberIds(workspaceId, sub) });
    } catch (error) {
      send(res, 400, { error: (error as Error).message });
    }
    return true;
  }

  if (resource === "groups" && req.method === "DELETE" && sub) {
    if (!UUID_PATTERN.test(sub)) {
      send(res, 400, { error: "invalid group id" });
      return true;
    }
    if (!await enterprise.deleteGroup(workspaceId, sub)) {
      send(res, 404, { error: "group not found" });
      return true;
    }
    await audit(req, workspaceId, actorUserId, "group.deleted", "group", sub);
    send(res, 200, { deleted: true });
    return true;
  }

  if (resource === "policies" && req.method === "GET" && !sub) {
    send(res, 200, { grants: await enterprise.listPermissionGrants(workspaceId) });
    return true;
  }

  if (resource === "policies" && req.method === "POST" && !sub) {
    const body = await jsonBody(req);
    const principalType = body?.principalType;
    const effect = body?.effect;
    const permission = body?.permission;
    const conditions = parseConditions(body?.conditions);
    if (
      !body || !["role", "user", "group"].includes(String(principalType)) ||
      typeof body.principalId !== "string" || !isWorkspacePermission(permission) ||
      !["allow", "deny"].includes(String(effect)) || conditions === null
    ) {
      send(res, 400, { error: "invalid permission grant" });
      return true;
    }
    const targetsOwner = principalType === "role" && body.principalId === "owner" ||
      principalType === "user" && await targetIsOwner(workspaceId, body.principalId);
    if (targetsOwner && access.membership.role !== "owner") {
      send(res, 403, { error: "only an owner can change owner grants" });
      return true;
    }
    try {
      const grant = await enterprise.upsertPermissionGrant({
        workspaceId,
        principalType: principalType as GrantPrincipalType,
        principalId: body.principalId,
        permission,
        effect: effect as GrantEffect,
        conditions,
      });
      await audit(req, workspaceId, actorUserId, "permission.upserted", "grant", grant.grantId, {
        principalType: grant.principalType,
        principalId: grant.principalId,
        permission: grant.permission,
        effect: grant.effect,
      });
      send(res, 201, grant);
    } catch (error) {
      send(res, 400, { error: (error as Error).message });
    }
    return true;
  }

  if (resource === "policies" && req.method === "DELETE" && sub) {
    if (!UUID_PATTERN.test(sub)) {
      send(res, 400, { error: "invalid grant id" });
      return true;
    }
    if (!await enterprise.deletePermissionGrant(workspaceId, sub)) {
      send(res, 404, { error: "grant not found" });
      return true;
    }
    await audit(req, workspaceId, actorUserId, "permission.deleted", "grant", sub);
    send(res, 200, { deleted: true });
    return true;
  }

  if (resource === "audit" && req.method === "GET" && !sub) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    send(res, 200, { events: await enterprise.listAuditEvents(workspaceId, Number.isFinite(limit) ? limit : 100) });
    return true;
  }

  send(res, 405, { error: "unsupported method or resource" });
  return true;
}
