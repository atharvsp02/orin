import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type PgBoss from "pg-boss";
import type { WorkspacePermission } from "./access.js";
import { authenticatedUser, requestOrigin, send } from "./auth.js";
import { config } from "./config.js";
import * as content from "./content-db.js";
import {
  CONTENT_POLICY_FIELDS,
  CONTENT_POLICY_OPERATORS,
  type ContentPolicyField,
  type ContentPolicyOperator,
} from "./content.js";
import type { ConnectorAccount } from "./connectors.js";
import * as db from "./db.js";
import * as enterprise from "./enterprise-db.js";
import { QUEUE, safeJobError, type DriveSyncJob, type GithubSyncJob, type LinearSyncJob } from "./queues.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const MAX_DOWNLOAD_BYTES = 2_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let queue: PgBoss | null = null;

interface DriveOAuthState {
  workspaceId: string;
  userId: string;
  expiresAt: number;
  nonce: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: Array<{ emailAddress?: string; permissionId?: string }>;
  parents?: string[];
  driveId?: string;
  size?: string;
  trashed?: boolean;
}

export interface DrivePermission {
  id?: string;
  type?: "user" | "group" | "domain" | "anyone";
  emailAddress?: string;
  domain?: string;
  role?: string;
  allowFileDiscovery?: boolean;
}

interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

const stateKey = () => Buffer.from(config.secret, "utf8");
const stateSign = (payload: string) => createHmac("sha256", stateKey()).update(`google-drive:${payload}`).digest("base64url");

export function encodeDriveState(state: DriveOAuthState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${stateSign(payload)}`;
}

export function decodeDriveState(value: string): DriveOAuthState | null {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(stateSign(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DriveOAuthState;
    if (!UUID_PATTERN.test(state.workspaceId) || !UUID_PATTERN.test(state.userId)) return null;
    if (!state.nonce || state.nonce.length < 16 || Date.now() > state.expiresAt) return null;
    return state;
  } catch {
    return null;
  }
}

export function setGoogleDriveQueue(value: PgBoss): void {
  queue = value;
}

function oauthConfigured(): boolean {
  return Boolean(config.googleDrive.clientId && config.googleDrive.clientSecret);
}

function callbackUrl(req: IncomingMessage): string {
  return `${requestOrigin(req)}/v1/connectors/google-drive/callback`;
}

export async function handleGoogleDriveStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!oauthConfigured()) return send(res, 404, { error: "Google Drive is not configured" });
  const auth = await authenticatedUser(req);
  if (!auth) return send(res, 401, { error: "not signed in" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const workspaceId = url.searchParams.get("workspaceId") ?? "";
  if (!UUID_PATTERN.test(workspaceId)) return send(res, 400, { error: "valid workspaceId is required" });
  if (!await enterprise.userCan(auth.user.userId, workspaceId, "connectors.manage", { connectorProvider: "gdrive" })) {
    return send(res, 403, { error: "connector administration permission required" });
  }
  const state = encodeDriveState({
    workspaceId,
    userId: auth.user.userId,
    expiresAt: Date.now() + 15 * 60_000,
    nonce: randomBytes(18).toString("base64url"),
  });
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", config.googleDrive.clientId as string);
  authorize.searchParams.set("redirect_uri", callbackUrl(req));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", `openid email profile ${DRIVE_SCOPE}`);
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("include_granted_scopes", "true");
  authorize.searchParams.set("prompt", "consent");
  authorize.searchParams.set("state", state);
  res.writeHead(302, { Location: authorize.toString(), "Cache-Control": "private, no-store, max-age=0" }).end();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Google API request failed with status ${response.status}`);
  return await response.json() as T;
}

export async function handleGoogleDriveCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!oauthConfigured()) return send(res, 404, { error: "Google Drive is not configured" });
  const auth = await authenticatedUser(req);
  if (!auth) return send(res, 401, { error: "not signed in" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const state = decodeDriveState(url.searchParams.get("state") ?? "");
  const code = url.searchParams.get("code") ?? "";
  if (!state || state.userId !== auth.user.userId || !code) return send(res, 400, { error: "invalid or expired Google Drive callback" });
  if (!await enterprise.userCan(auth.user.userId, state.workspaceId, "connectors.manage", { connectorProvider: "gdrive" })) {
    return send(res, 403, { error: "connector administration permission required" });
  }
  const token = await fetchJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleDrive.clientId as string,
      client_secret: config.googleDrive.clientSecret as string,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(req),
    }),
  });
  if (!token.access_token) return send(res, 502, { error: "Google Drive token exchange failed" });
  const profile = await fetchJson<{ sub?: string; email?: string; email_verified?: boolean; name?: string }>(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  );
  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    return send(res, 502, { error: "Google returned no verified account email" });
  }
  const existing = await db.getConnector("gdrive", profile.sub);
  if (existing && existing.workspaceId !== state.workspaceId) {
    return send(res, 409, { error: "this Google Drive account is already connected to another workspace" });
  }
  const previous = existing ? await content.getConnectorCredentials(existing.connectorId) : null;
  const refreshToken = token.refresh_token || String(previous?.data.refreshToken ?? "");
  if (!refreshToken) return send(res, 409, { error: "Google did not return offline access. Reconnect and approve consent." });
  try {
    await enterprise.addUserIdentity(auth.user.userId, {
      provider: "google",
      externalId: profile.sub,
      handle: profile.email,
      email: profile.email,
    });
  } catch (error) {
    return send(res, 409, { error: (error as Error).message });
  }
  const connector = await db.upsertConnector({
    connectorId: existing?.connectorId,
    workspaceId: state.workspaceId,
    provider: "gdrive",
    externalId: profile.sub,
    displayName: profile.email,
    status: "active",
    capabilities: ["ingest", "query"],
  });
  const expiresAt = new Date(Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000).toISOString();
  await content.storeConnectorCredentials({
    connectorId: connector.connectorId,
    data: {
      accessToken: token.access_token,
      refreshToken,
      tokenType: token.token_type ?? "Bearer",
      accountEmail: profile.email,
      accountId: profile.sub,
    },
    scopes: token.scope?.split(/\s+/).filter(Boolean) ?? [DRIVE_SCOPE],
    expiresAt,
  });
  await enterprise.recordAuditEvent({
    workspaceId: state.workspaceId,
    actorUserId: auth.user.userId,
    action: "connector.connected",
    targetType: "connector",
    targetId: connector.connectorId,
    details: { provider: "gdrive", accountEmail: profile.email },
  });
  res.writeHead(302, {
    Location: `/dashboard?workspace=${encodeURIComponent(state.workspaceId)}&connector=gdrive`,
    "Cache-Control": "private, no-store, max-age=0",
  }).end();
}

export function googleDriveExportMimeType(mimeType: string): string | null {
  if (mimeType === "application/vnd.google-apps.document") return "text/plain";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "text/csv";
  if (mimeType === "application/vnd.google-apps.presentation") return "text/plain";
  return null;
}

export function drivePermissionAcl(permission: DrivePermission): content.ContentAcl | null {
  if (permission.type === "anyone" && permission.allowFileDiscovery === true) {
    return { principalType: "anyone", principalKey: "*" };
  }
  if (permission.type === "domain" && permission.domain && permission.allowFileDiscovery === true) {
    return { principalType: "domain", principalKey: permission.domain };
  }
  if (permission.type === "group" && permission.emailAddress) {
    return { principalType: "external_group", principalKey: permission.emailAddress };
  }
  if (permission.type === "user" && permission.emailAddress) {
    return { principalType: "email", principalKey: permission.emailAddress };
  }
  if ((permission.type === "user" || permission.type === "group") && permission.id) {
    return { principalType: "google_permission", principalKey: permission.id };
  }
  return null;
}

export class GoogleDriveApiError extends Error {
  constructor(public readonly status: number, operation: string) {
    super(`${operation} failed with status ${status}`);
  }
}

export class GoogleDriveClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(url: URL): Promise<T> {
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!response.ok) throw new GoogleDriveApiError(response.status, "Google Drive API request");
    return await response.json() as T;
  }

  async listAllDrives(): Promise<Array<{ id: string; name: string }>> {
    const drives: Array<{ id: string; name: string }> = [];
    let pageToken = "";
    do {
      const url = new URL("https://www.googleapis.com/drive/v3/drives");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("fields", "nextPageToken,drives(id,name)");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.request<{ nextPageToken?: string; drives?: Array<{ id: string; name: string }> }>(url);
      drives.push(...(page.drives ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return drives;
  }

  async listAllFiles(): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken = "";
    do {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", "trashed = false");
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("corpora", "user");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,webViewLink,createdTime,modifiedTime,owners(emailAddress,permissionId),parents,driveId,size,trashed)");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.request<{ nextPageToken?: string; files?: DriveFile[] }>(url);
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return files;
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", "id,name,mimeType,webViewLink,createdTime,modifiedTime,owners(emailAddress,permissionId),parents,driveId,size,trashed");
    return this.request<DriveFile>(url);
  }

  async listPermissions(fileId: string): Promise<DrivePermission[]> {
    const permissions: DrivePermission[] = [];
    let pageToken = "";
    do {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`);
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("fields", "nextPageToken,permissions(id,type,emailAddress,domain,role,allowFileDiscovery)");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.request<{ nextPageToken?: string; permissions?: DrivePermission[] }>(url);
      permissions.push(...(page.permissions ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return permissions;
  }

  async getStartPageToken(): Promise<string> {
    const url = new URL("https://www.googleapis.com/drive/v3/changes/startPageToken");
    url.searchParams.set("supportsAllDrives", "true");
    const result = await this.request<{ startPageToken?: string }>(url);
    if (!result.startPageToken) throw new Error("Google Drive did not return a change cursor");
    return result.startPageToken;
  }

  async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }> {
    const url = new URL("https://www.googleapis.com/drive/v3/changes");
    url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,webViewLink,createdTime,modifiedTime,owners(emailAddress,permissionId),parents,driveId,size,trashed))");
    return this.request(url);
  }

  async downloadText(file: DriveFile): Promise<string | null> {
    if (file.mimeType === "application/vnd.google-apps.folder") return null;
    let url: URL;
    const exportMime = googleDriveExportMimeType(file.mimeType);
    if (exportMime) {
      url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`);
      url.searchParams.set("mimeType", exportMime);
    } else if (
      file.mimeType.startsWith("text/") ||
      ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(file.mimeType)
    ) {
      if (Number(file.size ?? 0) > MAX_DOWNLOAD_BYTES) return null;
      url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
      url.searchParams.set("alt", "media");
      url.searchParams.set("supportsAllDrives", "true");
    } else return null;
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!response.ok) throw new GoogleDriveApiError(response.status, "Google Drive content download");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  }
}

async function accessToken(connectorId: string): Promise<string> {
  const stored = await content.getConnectorCredentials(connectorId);
  if (!stored) throw new Error("Google Drive credentials are missing");
  const current = String(stored.data.accessToken ?? "");
  const expiresAt = stored.expiresAt ? new Date(stored.expiresAt).getTime() : 0;
  if (current && expiresAt > Date.now() + 60_000) return current;
  const refreshToken = String(stored.data.refreshToken ?? "");
  if (!refreshToken || !oauthConfigured()) throw new Error("Google Drive refresh token is missing");
  const refreshed = await fetchJson<{ access_token?: string; expires_in?: number; scope?: string; token_type?: string }>(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.googleDrive.clientId as string,
        client_secret: config.googleDrive.clientSecret as string,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    },
  );
  if (!refreshed.access_token) throw new Error("Google Drive token refresh failed");
  await content.storeConnectorCredentials({
    connectorId,
    data: { ...stored.data, accessToken: refreshed.access_token, refreshToken, tokenType: refreshed.token_type ?? "Bearer" },
    scopes: refreshed.scope?.split(/\s+/).filter(Boolean) ?? stored.scopes,
    expiresAt: new Date(Date.now() + Math.max(60, refreshed.expires_in ?? 3600) * 1000).toISOString(),
  });
  return refreshed.access_token;
}

async function filePath(client: GoogleDriveClient, file: DriveFile, cache: Map<string, DriveFile>): Promise<string> {
  const names = [file.name];
  let parentId = file.parents?.[0];
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId) && names.length < 20) {
    visited.add(parentId);
    let parent = cache.get(parentId);
    if (!parent) {
      parent = await client.getFile(parentId).catch(() => undefined);
      if (parent) cache.set(parent.id, parent);
    }
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parents?.[0];
  }
  return `/${names.join("/")}`;
}

async function syncFile(input: {
  client: GoogleDriveClient;
  workspaceId: string;
  connectorId: string;
  file: DriveFile;
  resources: Map<string, { resourceId: string; enabled: boolean }>;
  cache: Map<string, DriveFile>;
  syncRunId: string;
}): Promise<"written" | "skipped" | "deleted"> {
  const { client, workspaceId, connectorId, file, resources, cache, syncRunId } = input;
  if (file.trashed) {
    return await content.markContentDeleted(workspaceId, connectorId, file.id) ? "deleted" : "skipped";
  }
  const path = await filePath(client, file, cache);
  const resourceExternalId = file.driveId || "root";
  const resource = resources.get(resourceExternalId);
  if (!resource || !resource.enabled) {
    return await content.markContentDeleted(workspaceId, connectorId, file.id) ? "deleted" : "skipped";
  }
  const allowed = await content.connectorContentAllowed(workspaceId, connectorId, {
    provider: "gdrive",
    resourceId: resourceExternalId,
    owner: file.owners?.[0]?.emailAddress ?? "",
    mimeType: file.mimeType,
    path,
    sourceType: "document",
  });
  if (!allowed) {
    return await content.markContentDeleted(workspaceId, connectorId, file.id) ? "deleted" : "skipped";
  }
  const body = await client.downloadText(file);
  if (!body) {
    return await content.markContentDeleted(workspaceId, connectorId, file.id) ? "deleted" : "skipped";
  }
  let acls: content.ContentAcl[] = [];
  let aclStatus: "current" | "failed" = "current";
  try {
    const permissions = await client.listPermissions(file.id);
    acls = permissions.map(drivePermissionAcl).filter((entry) => entry !== null);
    for (const owner of file.owners ?? []) {
      if (owner.emailAddress) acls.push({ principalType: "email", principalKey: owner.emailAddress });
    }
  } catch {
    aclStatus = "failed";
  }
  await content.upsertContentItem({
    workspaceId,
    connectorId,
    resourceId: resource.resourceId,
    externalId: file.id,
    sourceType: "document",
    title: file.name,
    body,
    url: file.webViewLink ?? "",
    mimeType: file.mimeType,
    ownerKey: file.owners?.[0]?.emailAddress ?? "",
    sourcePath: path,
    visibility: "restricted",
    aclStatus,
    acls,
    sourceCreatedAt: file.createdTime,
    sourceUpdatedAt: file.modifiedTime,
    syncRunId,
    metadata: { driveId: file.driveId ?? "", parents: file.parents ?? [] },
  });
  return "written";
}

export async function runGoogleDriveSync(job: DriveSyncJob): Promise<void> {
  const connector = await db.getConnectorById(job.workspaceId, job.connectorId);
  if (!connector || connector.provider !== "gdrive") throw new Error("Google Drive connector not found");
  if (connector.status === "disabled") return;
  const run = await content.startConnectorSync(job.workspaceId, job.connectorId);
  const heartbeat = setInterval(() => {
    void content.heartbeatConnectorSync(job.workspaceId, run.runId).catch((error) => {
      console.warn("Google Drive sync heartbeat failed:", safeJobError(error));
    });
  }, 30_000);
  heartbeat.unref();
  let seen = 0;
  let written = 0;
  let deleted = 0;
  let failed = 0;
  try {
    const client = new GoogleDriveClient(await accessToken(job.connectorId));
    const resources = new Map<string, { resourceId: string; enabled: boolean }>();
    const root = await db.upsertConnectorResource({
      connectorId: job.connectorId,
      externalId: "root",
      kind: "drive",
      displayName: "My Drive",
    });
    resources.set("root", { resourceId: root.resourceId, enabled: root.enabled });
    for (const drive of await client.listAllDrives()) {
      const resource = await db.upsertConnectorResource({
        connectorId: job.connectorId,
        externalId: drive.id,
        kind: "shared_drive",
        displayName: drive.name,
      });
      resources.set(drive.id, { resourceId: resource.resourceId, enabled: resource.enabled });
    }
    const cache = new Map<string, DriveFile>();
    let cursor = await content.latestSuccessfulConnectorCursor(job.connectorId);
    const processFile = async (file: DriveFile) => {
      seen += 1;
      if (file.mimeType === "application/vnd.google-apps.folder") {
        if (await content.markContentDeleted(job.workspaceId, job.connectorId, file.id)) deleted += 1;
        return;
      }
      try {
        const result = await syncFile({
          client,
          workspaceId: job.workspaceId,
          connectorId: job.connectorId,
          file,
          resources,
          cache,
          syncRunId: run.runId,
        });
        if (result === "written") written += 1;
        if (result === "deleted") deleted += 1;
      } catch {
        failed += 1;
        await content.markContentSyncFailed(job.workspaceId, job.connectorId, file.id, run.runId);
      }
    };
    const fullSync = async () => {
      cursor = await client.getStartPageToken();
      const files = await client.listAllFiles();
      for (const file of files) cache.set(file.id, file);
      for (const file of files) await processFile(file);
      deleted += await content.markConnectorContentNotSeenInRun(job.workspaceId, job.connectorId, run.runId);
    };
    const incrementalSync = async () => {
      let pageToken = cursor;
      do {
        const page = await client.listChanges(pageToken);
        for (const change of page.changes) {
          if (change.removed || change.file?.trashed || !change.file) {
            seen += 1;
            if (await content.markContentDeleted(job.workspaceId, job.connectorId, change.fileId)) deleted += 1;
            continue;
          }
          cache.set(change.file.id, change.file);
          await processFile(change.file);
        }
        if (page.newStartPageToken) cursor = page.newStartPageToken;
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);
    };
    if (!cursor) await fullSync();
    else {
      try {
        await incrementalSync();
      } catch (error) {
        if (!(error instanceof GoogleDriveApiError) || error.status !== 410) throw error;
        await fullSync();
      }
    }
    await content.finishConnectorSync({
      workspaceId: job.workspaceId,
      runId: run.runId,
      status: failed > 0 ? "partial" : "succeeded",
      cursorValue: cursor,
      itemsSeen: seen,
      itemsWritten: written,
      itemsDeleted: deleted,
      errorText: failed > 0 ? `${failed} items failed closed until a successful retry` : "",
    });
    await db.setConnectorStatus(job.workspaceId, job.connectorId, "active");
    await enterprise.recordAuditEvent({
      workspaceId: job.workspaceId,
      actorUserId: job.actorUserId,
      action: "connector.sync_completed",
      targetType: "connector",
      targetId: job.connectorId,
      details: { seen, written, deleted, failed },
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
    await db.setConnectorStatus(job.workspaceId, job.connectorId, "error");
    await enterprise.recordAuditEvent({
      workspaceId: job.workspaceId,
      actorUserId: job.actorUserId,
      action: "connector.sync_failed",
      targetType: "connector",
      targetId: job.connectorId,
      outcome: "failure",
      details: { error: errorText },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > 100_000) throw new Error("request body is too large");
      chunks.push(buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function handleWorkspaceGoogleDrive(input: {
  req: IncomingMessage;
  res: ServerResponse;
  workspaceId: string;
  actorUserId: string;
  resource: string;
  sub?: string;
}): Promise<boolean> {
  const { req, res, workspaceId, actorUserId, resource, sub } = input;
  if (!["syncs", "connectorpolicies", "disconnects"].includes(resource)) return false;
  const connectorAllowed = async (
    connector: ConnectorAccount,
    permission: WorkspacePermission,
    resourceId?: string,
  ): Promise<boolean> => {
    const allowed = await enterprise.userCan(actorUserId, workspaceId, permission, {
      connectorProvider: connector.provider,
      ...(resourceId ? { resourceId } : {}),
    });
    if (allowed) return true;
    await enterprise.recordAuditEvent({
      workspaceId,
      actorUserId,
      action: "authorization.denied",
      targetType: "connector",
      targetId: connector.connectorId,
      outcome: "denied",
      details: { permission, connectorProvider: connector.provider, ...(resourceId ? { resourceId } : {}) },
    });
    send(res, 403, { error: "connector permission required" });
    return false;
  };

  if (resource === "syncs" && req.method === "GET" && !sub) {
    const connectors = await db.listConnectors(workspaceId);
    const visible = new Set((await Promise.all(connectors.map(async (connector) =>
      await enterprise.userCan(actorUserId, workspaceId, "connectors.read", { connectorProvider: connector.provider })
        ? connector.connectorId
        : null
    ))).filter((connectorId): connectorId is string => connectorId !== null));
    send(res, 200, {
      syncs: (await content.latestConnectorSyncs(workspaceId)).filter((sync) => visible.has(sync.connectorId)),
    });
    return true;
  }

  if (resource === "syncs" && req.method === "POST" && sub) {
    if (!UUID_PATTERN.test(sub)) {
      send(res, 400, { error: "invalid connector id" });
      return true;
    }
    const connector = await db.getConnectorById(workspaceId, sub);
    if (!connector || !["gdrive", "github", "linear"].includes(connector.provider)) {
      send(res, 404, { error: "syncable connector not found" });
      return true;
    }
    if (!await connectorAllowed(connector, "connectors.manage")) return true;
    if (connector.status === "disabled") {
      send(res, 409, { error: "enable the connector before syncing" });
      return true;
    }
    if (!queue) {
      send(res, 503, { error: "connector sync queue is unavailable" });
      return true;
    }
    const queueName = connector.provider === "github"
      ? QUEUE.githubSync
      : connector.provider === "linear"
        ? QUEUE.linearSync
        : QUEUE.driveSync;
    const job = {
      workspaceId,
      connectorId: sub,
      actorUserId,
      ...(connector.provider === "github" ? { backfill: true } : {}),
    } satisfies DriveSyncJob | GithubSyncJob | LinearSyncJob;
    const jobId = await queue.send(queueName, job, {
      singletonKey: sub,
      singletonSeconds: 60,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    });
    await enterprise.recordAuditEvent({
      workspaceId,
      actorUserId,
      action: "connector.sync_queued",
      targetType: "connector",
      targetId: connector.connectorId,
      details: { provider: connector.provider },
    });
    send(res, 202, { accepted: true, jobId });
    return true;
  }

  if (resource === "connectorpolicies" && req.method === "GET" && !sub) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const connectorId = url.searchParams.get("connectorId") ?? undefined;
    if (connectorId && !UUID_PATTERN.test(connectorId)) {
      send(res, 400, { error: "invalid connector id" });
      return true;
    }
    if (connectorId) {
      const connector = await db.getConnectorById(workspaceId, connectorId);
      if (!connector) {
        send(res, 404, { error: "connector not found" });
        return true;
      }
      if (!await connectorAllowed(connector, "policies.manage")) return true;
      send(res, 200, { policies: await content.listConnectorPolicies(workspaceId, connectorId) });
      return true;
    }
    const connectors = await db.listConnectors(workspaceId);
    const visible = new Set((await Promise.all(connectors.map(async (connector) =>
      await enterprise.userCan(actorUserId, workspaceId, "policies.manage", { connectorProvider: connector.provider })
        ? connector.connectorId
        : null
    ))).filter((connectorId): connectorId is string => connectorId !== null));
    send(res, 200, {
      policies: (await content.listConnectorPolicies(workspaceId)).filter((policy) => visible.has(policy.connectorId)),
    });
    return true;
  }

  if (resource === "connectorpolicies" && req.method === "POST" && !sub) {
    const body = await jsonBody(req);
    if (
      !body || typeof body.connectorId !== "string" || !UUID_PATTERN.test(body.connectorId) ||
      !["include", "exclude"].includes(String(body.effect)) ||
      !CONTENT_POLICY_FIELDS.includes(body.field as ContentPolicyField) ||
      !CONTENT_POLICY_OPERATORS.includes(body.operator as ContentPolicyOperator) ||
      !Array.isArray(body.values) || !body.values.every((value) => typeof value === "string")
    ) {
      send(res, 400, { error: "invalid connector policy" });
      return true;
    }
    const connector = await db.getConnectorById(workspaceId, body.connectorId);
    if (!connector) {
      send(res, 404, { error: "connector not found" });
      return true;
    }
    if (!await connectorAllowed(connector, "policies.manage")) return true;
    try {
      const policy = await content.upsertConnectorPolicy({
        workspaceId,
        connectorId: body.connectorId,
        effect: body.effect as "include" | "exclude",
        field: body.field as ContentPolicyField,
        operator: body.operator as ContentPolicyOperator,
        values: body.values as string[],
      });
      await enterprise.recordAuditEvent({
        workspaceId,
        actorUserId,
        action: "connector.policy_upserted",
        targetType: "connector_policy",
        targetId: policy.policyId,
        details: { connectorId: policy.connectorId, effect: policy.effect, field: policy.field },
      });
      send(res, 201, policy);
    } catch (error) {
      send(res, 400, { error: (error as Error).message });
    }
    return true;
  }

  if (resource === "connectorpolicies" && req.method === "DELETE" && sub) {
    if (!UUID_PATTERN.test(sub)) {
      send(res, 400, { error: "invalid policy id" });
      return true;
    }
    const policy = await content.getConnectorPolicy(workspaceId, sub);
    if (!policy) {
      send(res, 404, { error: "policy not found" });
      return true;
    }
    const connector = await db.getConnectorById(workspaceId, policy.connectorId);
    if (!connector || !await connectorAllowed(connector, "policies.manage")) return true;
    if (!await content.deleteConnectorPolicy(workspaceId, sub)) {
      send(res, 404, { error: "policy not found" });
      return true;
    }
    await enterprise.recordAuditEvent({
      workspaceId,
      actorUserId,
      action: "connector.policy_deleted",
      targetType: "connector_policy",
      targetId: sub,
    });
    send(res, 200, { deleted: true });
    return true;
  }

  if (resource === "disconnects" && req.method === "DELETE" && sub) {
    if (!UUID_PATTERN.test(sub)) {
      send(res, 400, { error: "invalid connector id" });
      return true;
    }
    const connector = await db.getConnectorById(workspaceId, sub);
    if (!connector || connector.provider !== "gdrive") {
      send(res, 404, { error: "Google Drive connector not found" });
      return true;
    }
    if (!await connectorAllowed(connector, "connectors.manage")) return true;
    const credentials = await content.getConnectorCredentials(sub);
    const token = String(credentials?.data.refreshToken ?? credentials?.data.accessToken ?? "");
    if (token) {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      }).catch(() => undefined);
    }
    await content.deleteConnectorCredentials(sub);
    await content.markConnectorAclStale(workspaceId, sub);
    await db.setConnectorStatus(workspaceId, sub, "disabled");
    await enterprise.recordAuditEvent({
      workspaceId,
      actorUserId,
      action: "connector.disconnected",
      targetType: "connector",
      targetId: sub,
      details: { provider: "gdrive" },
    });
    send(res, 200, { disconnected: true });
    return true;
  }

  send(res, 405, { error: "unsupported method or resource" });
  return true;
}
