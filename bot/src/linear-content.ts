import { LinearClient } from "@linear/sdk";
import { connectorSupports, type ConnectorAccount, type ConnectorResource } from "./connectors.js";
import * as content from "./content-db.js";
import * as db from "./db.js";
import * as enterprise from "./enterprise-db.js";
import { safeJobError, type LinearSyncJob } from "./queues.js";

const MAX_PAGE_ITEMS = 50_000;
const MAX_CONTENT_BYTES = 1_900_000;
const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface StoredLinearInstall {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
  orgName?: string;
  appUserId?: string;
}

export interface LinearUserLike {
  id: string;
  name?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string | null;
  active: boolean;
  app: boolean;
  guest?: boolean;
  admin?: boolean;
  owner?: boolean;
  canAccessAnyPublicTeam?: boolean;
}

export interface LinearTeamLike {
  id: string;
  key?: string;
  name: string;
  displayName?: string;
  private?: boolean;
  visibility?: string;
  archivedAt?: Date | string | null;
  retiredAt?: Date | string | null;
  members(input?: { first?: number }): Promise<LinearConnectionLike<LinearUserLike>>;
}

interface LinearCommentLike {
  id: string;
  body: string;
  userId?: string;
  botActor?: unknown;
  archivedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface LinearIssueLike {
  id: string;
  identifier?: string;
  title: string;
  description?: string | null;
  url?: string;
  creatorId?: string;
  labelIds?: string[];
  trashed?: boolean | null;
  archivedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  team?: Promise<LinearTeamLike>;
  sharedAccess?: {
    isShared?: boolean;
    sharedWithUsers?: LinearUserLike[];
  };
  comments(input?: { first?: number }): Promise<LinearConnectionLike<LinearCommentLike>>;
}

interface LinearConnectionLike<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
  fetchNext(): Promise<LinearConnectionLike<T>>;
}

export interface LinearApiLike {
  issue(id: string): Promise<LinearIssueLike>;
  issues(input?: Record<string, unknown>): Promise<LinearConnectionLike<LinearIssueLike>>;
  teams(input?: { first?: number; includeArchived?: boolean }): Promise<LinearConnectionLike<LinearTeamLike>>;
  users(input?: { first?: number }): Promise<LinearConnectionLike<LinearUserLike>>;
  team(id: string): Promise<LinearTeamLike>;
}

interface LinearDirectory {
  users: Map<string, LinearUserLike>;
  publicUsers: LinearUserLike[];
}

interface LinearContext {
  orgId: string;
  connector: ConnectorAccount;
  client: LinearApiLike;
  directory?: Promise<LinearDirectory>;
  refreshAcl: boolean;
  appUserId?: string;
  teams: Map<string, Promise<{ resource: ConnectorResource; team: LinearTeamLike }>>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function installValue(value: unknown): StoredLinearInstall | null {
  const record = objectValue(value);
  const accessToken = stringValue(record?.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: stringValue(record?.refreshToken) || undefined,
    expiresAt: stringValue(record?.expiresAt) || undefined,
    scopes: Array.isArray(record?.scopes) ? record.scopes.map(stringValue).filter(Boolean) : undefined,
    orgName: stringValue(record?.orgName) || undefined,
    appUserId: stringValue(record?.appUserId) || undefined,
  };
}

function expiresSoon(value?: string): boolean {
  if (!value) return false;
  const expiresAt = new Date(value).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5 * 60_000;
}

export async function linearAccessToken(
  orgId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const current = installValue(await db.fetchLinearInstall(orgId));
  if (!current) throw new Error("Linear installation credentials are missing");
  if (!expiresSoon(current.expiresAt)) return current.accessToken;
  if (!current.refreshToken) return current.accessToken;
  const updated = await db.mutateLinearInstall(orgId, async (value) => {
    const locked = installValue(value);
    if (!locked) throw new Error("Linear installation credentials are invalid");
    if (!expiresSoon(locked.expiresAt) || !locked.refreshToken) return locked;
    const response = await fetchImpl("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: locked.refreshToken,
        client_id: process.env.LINEAR_CLIENT_ID ?? "",
        client_secret: process.env.LINEAR_CLIENT_SECRET ?? "",
      }),
    });
    if (!response.ok) throw new Error(`Linear token refresh failed with status ${response.status}`);
    const token = objectValue(await response.json());
    const accessToken = stringValue(token?.access_token);
    if (!accessToken) throw new Error("Linear token refresh returned no access token");
    const refreshToken = stringValue(token?.refresh_token);
    if (!refreshToken) throw new Error("Linear token refresh returned no refresh token");
    const expiresIn = Number(token?.expires_in ?? 86_400);
    const scope = token?.scope;
    const scopes = Array.isArray(scope)
      ? scope.map(stringValue).filter(Boolean)
      : stringValue(scope).split(/[\s,]+/).filter(Boolean);
    return {
      ...locked,
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 86_400) * 1000).toISOString(),
      scopes: scopes.length ? scopes : locked.scopes,
    } satisfies StoredLinearInstall;
  });
  const install = installValue(updated);
  if (!install) throw new Error("Linear installation disappeared during token refresh");
  return install.accessToken;
}

export async function linearClientForOrg(orgId: string): Promise<LinearApiLike> {
  return new LinearClient({ accessToken: await linearAccessToken(orgId) }) as unknown as LinearApiLike;
}

async function allPages<T>(first: Promise<LinearConnectionLike<T>>): Promise<T[]> {
  const connection = await first;
  const result = [...connection.nodes];
  let known = connection.nodes.length;
  let pages = 0;
  while (connection.pageInfo.hasNextPage) {
    if (++pages > 1000 || result.length >= MAX_PAGE_ITEMS) throw new Error("Linear pagination exceeded the safety limit");
    await connection.fetchNext();
    if (connection.nodes.length <= known) throw new Error("Linear pagination did not advance");
    result.push(...connection.nodes.slice(known));
    known = connection.nodes.length;
  }
  if (result.length > MAX_PAGE_ITEMS) throw new Error("Linear result exceeds the safety limit");
  return result;
}

function activeHuman(user: LinearUserLike): boolean {
  return Boolean(user.id && user.active && !user.app);
}

export function linearUserAcl(orgId: string, user: LinearUserLike): content.ContentAcl | null {
  return activeHuman(user) ? { principalType: "linear_user", principalKey: `${orgId}:${user.id}` } : null;
}

export function linearTeamMembershipAcls(
  orgId: string,
  team: Pick<LinearTeamLike, "visibility" | "private">,
  directoryUsers: LinearUserLike[],
  teamMembers: LinearUserLike[],
): content.ContentAcl[] {
  const visible = team.visibility === "public" || (team.visibility === undefined && team.private === false)
    ? [...directoryUsers.filter((user) => user.canAccessAnyPublicTeam), ...teamMembers]
    : teamMembers;
  const principals = new Map<string, content.ContentAcl>();
  for (const user of visible) {
    const acl = linearUserAcl(orgId, user);
    if (acl) principals.set(acl.principalKey.toLowerCase(), acl);
  }
  return [...principals.values()];
}

async function upsertLinearUsers(orgId: string, users: LinearUserLike[]): Promise<void> {
  const active = users.filter((user) => activeHuman(user) && stringValue(user.email));
  for (let offset = 0; offset < active.length; offset += 20) {
    await Promise.all(active.slice(offset, offset + 20).map((user) => enterprise.upsertUserIdentity({
      provider: "linear_user",
      externalId: `${orgId}:${user.id}`,
      handle: user.id,
      displayName: stringValue(user.name) || stringValue(user.displayName) || stringValue(user.email).split("@")[0],
      email: stringValue(user.email),
      avatarUrl: stringValue(user.avatarUrl) || undefined,
      reactivate: false,
    })));
  }
}

async function linearDirectory(orgId: string, client: LinearApiLike): Promise<LinearDirectory> {
  const users = await allPages(client.users({ first: 250 }));
  await upsertLinearUsers(orgId, users);
  return {
    users: new Map(users.map((user) => [user.id, user])),
    publicUsers: users.filter((user) => activeHuman(user) && user.canAccessAnyPublicTeam === true),
  };
}

function context(
  orgId: string,
  connector: ConnectorAccount,
  client: LinearApiLike,
  refreshAcl = false,
  appUserId?: string,
): LinearContext {
  return {
    orgId,
    connector,
    client,
    refreshAcl,
    appUserId,
    teams: new Map(),
  };
}

function contextDirectory(ctx: LinearContext): Promise<LinearDirectory> {
  ctx.directory ??= linearDirectory(ctx.orgId, ctx.client);
  return ctx.directory;
}

function resourceAclFresh(resource: ConnectorResource): boolean {
  if (resource.aclStatus !== "current" || !resource.aclSyncedAt) return false;
  const syncedAt = new Date(resource.aclSyncedAt).getTime();
  return Number.isFinite(syncedAt) && Date.now() - syncedAt < 25 * 60_000;
}

async function syncTeam(ctx: LinearContext, teamInput: LinearTeamLike): Promise<{ resource: ConnectorResource; team: LinearTeamLike }> {
  const existing = ctx.teams.get(teamInput.id);
  if (existing) return existing;
  const operation = (async () => {
    const team = await ctx.client.team(teamInput.id).catch(() => teamInput);
    const resource = await db.upsertConnectorResource({
      connectorId: ctx.connector.connectorId,
      externalId: team.id,
      kind: "team",
      displayName: stringValue(team.displayName) || team.name || team.id,
    });
    if (!resource.enabled || (!ctx.refreshAcl && resourceAclFresh(resource))) return { resource, team };
    try {
      const [directory, members] = await Promise.all([
        contextDirectory(ctx),
        allPages(team.members({ first: 250 })),
      ]);
      await upsertLinearUsers(ctx.orgId, members);
      await content.replaceConnectorResourceMemberships(
        ctx.connector.workspaceId,
        resource.resourceId,
        linearTeamMembershipAcls(ctx.orgId, team, directory.publicUsers, members),
      );
      return { resource: { ...resource, aclStatus: "current" as const }, team };
    } catch (error) {
      await content.markConnectorResourceAclStatus(ctx.connector.workspaceId, resource.resourceId, "failed");
      throw error;
    }
  })();
  ctx.teams.set(teamInput.id, operation);
  return operation;
}

function iso(value?: Date | string | null): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function boundedBody(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= MAX_CONTENT_BYTES ? value : bytes.subarray(0, MAX_CONTENT_BYTES).toString("utf8");
}

async function syncIssue(ctx: LinearContext, issue: LinearIssueLike, syncRunId?: string): Promise<"written" | "deleted" | "skipped"> {
  const externalId = `issue:${issue.id}`;
  if (issue.trashed) {
    return await content.markContentDeleted(ctx.connector.workspaceId, ctx.connector.connectorId, externalId) ? "deleted" : "skipped";
  }
  const team = await issue.team;
  if (!team) throw new Error(`Linear issue ${issue.id} has no team`);
  const teamState = await syncTeam(ctx, team);
  if (!teamState.resource.enabled) {
    return await content.markContentDeleted(ctx.connector.workspaceId, ctx.connector.connectorId, externalId) ? "deleted" : "skipped";
  }
  const allowed = await content.connectorContentAllowed(ctx.connector.workspaceId, ctx.connector.connectorId, {
    provider: "linear",
    resourceId: team.id,
    owner: issue.creatorId ?? "",
    mimeType: "text/markdown",
    path: team.name,
    sourceType: "issue",
  });
  if (!allowed) {
    return await content.markContentDeleted(ctx.connector.workspaceId, ctx.connector.connectorId, externalId) ? "deleted" : "skipped";
  }
  const comments = await allPages(issue.comments({ first: 250 }));
  const directory = ctx.directory ? await ctx.directory : undefined;
  const visibleComments = comments.filter((comment) => (
    !comment.archivedAt
    && !comment.botActor
    && comment.userId !== ctx.appUserId
    && comment.body.trim()
  ));
  const commentText = visibleComments.map((comment) => {
    const author = comment.userId ? directory?.users.get(comment.userId) : undefined;
    const name = stringValue(author?.name) || stringValue(author?.displayName) || comment.userId || "Linear user";
    return `${name}: ${comment.body.trim()}`;
  });
  const sharedUsers = issue.sharedAccess?.sharedWithUsers?.filter(activeHuman) ?? [];
  await upsertLinearUsers(ctx.orgId, sharedUsers);
  const sharedAcls = sharedUsers.map((user) => linearUserAcl(ctx.orgId, user)).filter((acl) => acl !== null);
  const body = boundedBody([
    issue.title,
    issue.description?.trim() ?? "",
    commentText.length ? `Comments\n${commentText.join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n"));
  await content.upsertContentItem({
    workspaceId: ctx.connector.workspaceId,
    connectorId: ctx.connector.connectorId,
    resourceId: teamState.resource.resourceId,
    externalId,
    sourceType: "issue",
    title: `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.title}`,
    body,
    url: issue.url ?? "",
    mimeType: "text/markdown",
    ownerKey: issue.creatorId ?? "",
    sourcePath: stringValue(team.displayName) || team.name,
    visibility: "restricted",
    aclStatus: "current",
    acls: [
      { principalType: "resource_member", principalKey: teamState.resource.resourceId },
      ...sharedAcls,
    ],
    metadata: {
      organizationId: ctx.orgId,
      teamId: team.id,
      teamKey: team.key ?? "",
      teamVisibility: team.visibility ?? (team.private ? "private" : "public"),
      shared: issue.sharedAccess?.isShared === true,
      sharedWithCount: sharedAcls.length,
      commentCount: visibleComments.length,
      labelIds: issue.labelIds ?? [],
    },
    sourceCreatedAt: iso(issue.createdAt),
    sourceUpdatedAt: iso(issue.updatedAt),
    syncRunId,
  });
  return "written";
}

export async function ingestLinearIssue(
  orgId: string,
  issueId: string,
  clientInput?: LinearApiLike,
): Promise<"written" | "deleted" | "skipped"> {
  const client = clientInput ?? await linearClientForOrg(orgId);
  return ingestLinearIssueObject(orgId, await client.issue(issueId), client);
}

export async function ingestLinearIssueObject(
  orgId: string,
  issue: LinearIssueLike,
  client: LinearApiLike,
): Promise<"written" | "deleted" | "skipped"> {
  const connector = await db.getConnector("linear", orgId);
  if (!connector || !connectorSupports(connector, "ingest")) return "skipped";
  const install = installValue(await db.fetchLinearInstall(orgId));
  return syncIssue(context(orgId, connector, client, false, install?.appUserId), issue);
}

export async function deleteLinearIssue(orgId: string, issueId: string): Promise<boolean> {
  const connector = await db.getConnector("linear", orgId);
  return Boolean(connector && await content.markContentDeleted(
    connector.workspaceId,
    connector.connectorId,
    `issue:${issueId}`,
  ));
}

interface LinearCursor {
  updatedAt?: string;
  lastFullAt?: string;
}

function parseCursor(value: string): LinearCursor {
  if (!value) return {};
  try {
    const parsed = objectValue(JSON.parse(value));
    const timestamp = (input: unknown): string | undefined => {
      const raw = stringValue(input);
      if (!raw) return undefined;
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    };
    return { updatedAt: timestamp(parsed?.updatedAt), lastFullAt: timestamp(parsed?.lastFullAt) };
  } catch {
    return {};
  }
}

export async function runLinearSync(job: LinearSyncJob, clientInput?: LinearApiLike): Promise<void> {
  const connector = await db.getConnectorById(job.workspaceId, job.connectorId);
  if (!connector || connector.provider !== "linear") throw new Error("Linear connector not found");
  if (connector.status === "disabled") return;
  const run = await content.startConnectorSync(job.workspaceId, job.connectorId);
  const heartbeat = setInterval(() => {
    void content.heartbeatConnectorSync(job.workspaceId, run.runId).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  let seen = 0;
  let written = 0;
  let deleted = 0;
  let failed = 0;
  try {
    const startedAt = new Date().toISOString();
    const previous = parseCursor(await content.latestSuccessfulConnectorCursor(connector.connectorId));
    const lastFullAt = previous.lastFullAt ? new Date(previous.lastFullAt).getTime() : 0;
    const full = !previous.updatedAt || !Number.isFinite(lastFullAt) || Date.now() - lastFullAt >= FULL_SYNC_INTERVAL_MS;
    const client = clientInput ?? await linearClientForOrg(connector.externalId);
    const install = installValue(await db.fetchLinearInstall(connector.externalId));
    const ctx = context(connector.externalId, connector, client, true, install?.appUserId);
    await content.markConnectorResourcesAclStatus(job.workspaceId, job.connectorId, "stale");
    const teams = await allPages(client.teams({ first: 100, includeArchived: false }));
    for (const team of teams.filter((item) => !item.archivedAt && !item.retiredAt)) await syncTeam(ctx, team);
    const issues = await allPages(client.issues({
      first: 100,
      includeArchived: true,
      ...(full ? {} : { filter: { updatedAt: { gte: new Date(previous.updatedAt as string) } } }),
    }));
    for (const issue of issues) {
      seen += 1;
      try {
        const result = await syncIssue(ctx, issue, run.runId);
        if (result === "written") written += 1;
        if (result === "deleted") deleted += 1;
      } catch {
        failed += 1;
        await content.markContentSyncFailed(job.workspaceId, job.connectorId, `issue:${issue.id}`, run.runId);
      }
    }
    if (full) deleted += await content.markConnectorContentNotSeenInRun(job.workspaceId, job.connectorId, run.runId);
    await content.finishConnectorSync({
      workspaceId: job.workspaceId,
      runId: run.runId,
      status: failed ? "partial" : "succeeded",
      cursorValue: JSON.stringify(failed
        ? previous
        : { updatedAt: startedAt, lastFullAt: full ? startedAt : previous.lastFullAt }),
      itemsSeen: seen,
      itemsWritten: written,
      itemsDeleted: deleted,
      errorText: failed ? `${failed} Linear issues failed closed until a successful retry` : "",
    });
    await db.setConnectorStatus(job.workspaceId, job.connectorId, "active");
    await enterprise.recordAuditEvent({
      workspaceId: job.workspaceId,
      actorUserId: job.actorUserId,
      action: "connector.sync_completed",
      targetType: "connector",
      targetId: job.connectorId,
      details: { provider: "linear", full, seen, written, deleted, failed },
    });
  } catch (error) {
    const errorText = safeJobError(error);
    await content.finishConnectorSync({
      workspaceId: job.workspaceId,
      runId: run.runId,
      status: "failed",
      itemsSeen: seen,
      itemsWritten: written,
      itemsDeleted: deleted,
      errorText,
    });
    await content.markConnectorAclStale(job.workspaceId, job.connectorId);
    await content.markConnectorResourcesAclStatus(job.workspaceId, job.connectorId, "failed");
    await db.setConnectorStatus(job.workspaceId, job.connectorId, "error");
    await enterprise.recordAuditEvent({
      workspaceId: job.workspaceId,
      actorUserId: job.actorUserId,
      action: "connector.sync_failed",
      targetType: "connector",
      targetId: job.connectorId,
      outcome: "failure",
      details: { provider: "linear", error: errorText },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function disableLinearConnector(orgId: string): Promise<void> {
  const connector = await db.getConnector("linear", orgId);
  await db.deleteLinearInstall(orgId);
  if (!connector) return;
  await content.markConnectorAclStale(connector.workspaceId, connector.connectorId);
  await content.markConnectorResourcesAclStatus(connector.workspaceId, connector.connectorId, "failed");
  await db.setConnectorEnabled(connector.workspaceId, connector.connectorId, false);
  await enterprise.recordAuditEvent({
    workspaceId: connector.workspaceId,
    action: "connector.authorization_revoked",
    targetType: "connector",
    targetId: connector.connectorId,
    details: { provider: "linear" },
  });
}
