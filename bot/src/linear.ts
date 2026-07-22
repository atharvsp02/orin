import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { LinearClient } from "@linear/sdk";
import PgBoss from "pg-boss";
import { config } from "./config.js";
import * as content from "./content-db.js";
import * as db from "./db.js";
import * as enterprise from "./enterprise-db.js";
import { answerQuestion } from "./llm.js";
import {
  deleteLinearIssue,
  disableLinearConnector,
  ingestLinearIssue,
  ingestLinearIssueObject,
  linearClientForOrg,
  type LinearApiLike,
  type LinearIssueLike,
  type LinearUserLike,
  type StoredLinearInstall,
} from "./linear-content.js";
import { provisionAndLink } from "./tenant.js";
import { QUEUE, type LinearWebhookJob } from "./queues.js";

interface Linear extends LinearApiLike {
  createAgentActivity(input: { agentSessionId: string; content: Record<string, unknown> }): Promise<unknown>;
  organization: Promise<{ id: string; name: string }>;
  viewer: Promise<LinearUserLike>;
  user(id: string): Promise<LinearUserLike>;
}

interface WebhookBase {
  type: string;
  action?: string;
  organizationId?: string;
  webhookTimestamp?: number;
}

interface WebhookUser {
  id?: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

interface AgentSessionWebhook extends WebhookBase {
  type: "AgentSessionEvent";
  action: "created" | "prompted";
  promptContext?: string;
  agentActivity?: { content?: { body?: string }; user?: WebhookUser };
  agentSession: {
    id: string;
    creatorId?: string;
    creator?: WebhookUser;
    issueId?: string;
    issue?: { id?: string; title?: string; description?: string; teamId?: string };
    comment?: { body?: string };
  };
}

interface IssueWebhook extends WebhookBase {
  type: "Issue";
  action: "create" | "update" | "remove";
  data: { id: string };
}

interface CommentWebhook extends WebhookBase {
  type: "Comment";
  action: "create" | "update" | "remove";
  data: { issueId?: string };
}

interface AppTeamAccessWebhook extends WebhookBase {
  type: "PermissionChange" | "AppUserTeamAccessChanged";
  removedTeamIds?: string[];
}

const REDIRECT_URI = process.env.LINEAR_REDIRECT_URI ?? "https://orin-bot.duckdns.org/linear/oauth";
const INSTALL_COOKIE = "orin_linear_install";
const INSTALL_TTL_MS = 15 * 60_000;
const WEBHOOK_TOLERANCE_MS = 60_000;

function reqEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Linear adapter needs ${name}`);
  return value;
}

function clientFor(token: string): Linear {
  return new LinearClient({ accessToken: token }) as unknown as Linear;
}

async function clientForOrg(orgId: string): Promise<Linear | null> {
  if (!await db.fetchLinearInstall(orgId)) return null;
  return await linearClientForOrg(orgId) as Linear;
}

function equalHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyLinearWebhook(
  secret: string,
  raw: string,
  signature: string,
  now = Date.now(),
): boolean {
  const supplied = signature.replace(/^sha256=/i, "").trim();
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  if (!equalHex(expected, supplied)) return false;
  try {
    const parsed = JSON.parse(raw) as { webhookTimestamp?: unknown };
    const timestamp = Number(parsed.webhookTimestamp);
    return Number.isFinite(timestamp) && Math.abs(now - timestamp) <= WEBHOOK_TOLERANCE_MS;
  } catch {
    return false;
  }
}

function stateMac(secret: string, nonce: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`linear-install:${nonce}:${timestamp}`).digest("hex");
}

export function mintLinearInstallState(secret: string, nonce: string, now = Date.now()): string {
  const timestamp = String(now);
  return `${nonce}.${timestamp}.${stateMac(secret, nonce, timestamp)}`;
}

export function checkLinearInstallState(
  secret: string,
  state: string,
  cookieNonce: string,
  now = Date.now(),
): boolean {
  const [nonce, timestamp, mac, extra] = state.split(".");
  if (extra || !nonce || !timestamp || !mac || nonce !== cookieNonce) return false;
  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt) || issuedAt > now + WEBHOOK_TOLERANCE_MS || now - issuedAt > INSTALL_TTL_MS) return false;
  return equalHex(stateMac(secret, nonce, timestamp), mac);
}

export function linearInstallCodeVerifier(secret: string, nonce: string): string {
  return createHmac("sha256", secret).update(`linear-install-pkce:${nonce}`).digest("base64url");
}

export function linearInstallCodeChallenge(secret: string, nonce: string): string {
  return createHash("sha256").update(linearInstallCodeVerifier(secret, nonce)).digest("base64url");
}

export function linearInlineAnswerAllowed(issue: Pick<LinearIssueLike, "sharedAccess">): boolean {
  return issue.sharedAccess?.isShared !== true;
}

export function linearAdministrator(user: Pick<LinearUserLike, "active" | "app" | "admin" | "owner">): boolean {
  return user.active && !user.app && (user.admin === true || user.owner === true);
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
  }
  return cookies;
}

function installCookie(value: string, maxAge: number): string {
  const secure = new URL(REDIRECT_URI).protocol === "https:" ? "; Secure" : "";
  return `${INSTALL_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const escapeHtml = (value: string): string => value.replace(
  /[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string,
);

function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:36rem;margin:4rem auto">${body}</body>`);
}

export function handleLinearInstall(req: IncomingMessage, res: ServerResponse, secret: string): void {
  const clientId = process.env.LINEAR_CLIENT_ID;
  if (!clientId) {
    html(res, 404, "<h2>Orin</h2><p>Linear OAuth is not configured on this server.</p>");
    return;
  }
  const nonce = randomBytes(24).toString("base64url");
  const authorize = new URL("https://linear.app/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  const actor = process.env.LINEAR_ACTOR ?? "app";
  authorize.searchParams.set("scope", process.env.LINEAR_SCOPES ?? (actor === "app"
    ? "read,write,app:mentionable,app:assignable"
    : "read,write"));
  authorize.searchParams.set("actor", actor);
  authorize.searchParams.set("prompt", "consent");
  authorize.searchParams.set("state", mintLinearInstallState(secret, nonce));
  authorize.searchParams.set("code_challenge", linearInstallCodeChallenge(secret, nonce));
  authorize.searchParams.set("code_challenge_method", "S256");
  res.writeHead(302, {
    Location: authorize.toString(),
    "Cache-Control": "no-store",
    "Set-Cookie": installCookie(nonce, Math.floor(INSTALL_TTL_MS / 1000)),
  }).end();
}

function scopesFrom(value: unknown): string[] {
  const scopes = Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[\s,]+/);
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

async function handleOAuthCallback(req: IncomingMessage, res: ServerResponse, secret: string, boss: PgBoss): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const cookieNonce = parseCookies(req).get(INSTALL_COOKIE) ?? "";
  const clearCookie = installCookie("", 0);
  if (!code || !checkLinearInstallState(secret, state, cookieNonce)) {
    html(res, 400, "<h2>Orin</h2><p>Invalid or expired install link. Start again from /linear/install.</p>", { "Set-Cookie": clearCookie });
    return;
  }
  const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: reqEnv("LINEAR_CLIENT_ID"),
      client_secret: reqEnv("LINEAR_CLIENT_SECRET"),
      code_verifier: linearInstallCodeVerifier(secret, cookieNonce),
    }),
  });
  if (!tokenResponse.ok) {
    console.error("linear oauth exchange failed:", tokenResponse.status);
    html(res, 502, "<h2>Orin</h2><p>Token exchange with Linear failed. Try installing again.</p>", { "Set-Cookie": clearCookie });
    return;
  }
  const token = await tokenResponse.json() as Record<string, unknown>;
  const accessToken = typeof token.access_token === "string" ? token.access_token : "";
  const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : "";
  if (!accessToken || !refreshToken) {
    html(res, 502, "<h2>Orin</h2><p>Linear returned incomplete OAuth credentials.</p>", { "Set-Cookie": clearCookie });
    return;
  }
  const client = clientFor(accessToken);
  const [organization, viewer] = await Promise.all([client.organization, client.viewer]);
  const expiresIn = Number(token.expires_in ?? 86_400);
  const install: StoredLinearInstall = {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 86_400) * 1000).toISOString(),
    scopes: scopesFrom(token.scope),
    orgName: organization.name,
    appUserId: viewer.id,
  };
  await db.storeLinearInstall(organization.id, install);
  const tenant = await provisionAndLink(
    { provider: "linear", externalId: organization.id },
    `linear:${organization.name}`,
  );
  await db.upsertConnector({
    connectorId: tenant.connector.connectorId,
    workspaceId: tenant.workspaceId,
    provider: "linear",
    externalId: organization.id,
    displayName: organization.name,
    status: "active",
    capabilities: tenant.connector.capabilities,
  });
  await boss.send(QUEUE.linearSync, {
    workspaceId: tenant.workspaceId,
    connectorId: tenant.connector.connectorId,
  }, {
    singletonKey: tenant.connector.connectorId,
    singletonSeconds: 15 * 60,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  }).catch((error) => {
    console.error("linear initial sync queue failed:", error instanceof Error ? error.message : String(error));
  });
  html(
    res,
    200,
    `<h2>Orin installed for ${escapeHtml(organization.name)}</h2><p>Permission-aware issue indexing starts automatically. Mention Orin in an issue to ask a question.</p>`,
    { "Set-Cookie": clearCookie },
  );
}

function directPrompt(webhook: AgentSessionWebhook): string {
  return (webhook.agentActivity?.content?.body ?? webhook.agentSession.comment?.body ?? "")
    .replace(/@orin/gi, "")
    .trim();
}

function sessionQuestion(webhook: AgentSessionWebhook): string {
  return [
    directPrompt(webhook),
    webhook.promptContext,
    webhook.agentSession.issue?.title,
    webhook.agentSession.issue?.description,
  ].filter(Boolean).join("\n\n").trim().slice(0, 4000);
}

function responseWithSources(answer: string, evidence: content.SearchResult[]): string {
  const sources = evidence
    .map((item, index) => item.url ? `[${index + 1}] ${item.title}: ${item.url}` : "")
    .filter(Boolean);
  return `${answer}${sources.length ? `\n\nSources\n${sources.join("\n")}` : ""}`.slice(0, 9500);
}

async function handleSession(client: Linear, webhook: AgentSessionWebhook): Promise<void> {
  const sessionId = webhook.agentSession.id;
  const respond = (body: string) => client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "response", body: body.slice(0, 9500) },
  });
  const orgId = webhook.organizationId;
  const issueId = webhook.agentSession.issueId ?? webhook.agentSession.issue?.id;
  const creatorId = webhook.agentSession.creatorId ?? webhook.agentSession.creator?.id;
  if (!orgId || !issueId || !creatorId) {
    await respond("I can only answer when a signed-in Linear user asks from an issue.");
    return;
  }
  const connector = await db.getConnector("linear", orgId);
  if (!connector || connector.status !== "active") {
    await respond("Orin is not active for this Linear workspace. Ask an administrator to reconnect it.");
    return;
  }
  const creator = await client.user(creatorId);
  if (!creator.active || creator.app) {
    await respond("I can only answer questions from active human workspace members.");
    return;
  }
  const user = await enterprise.upsertUserIdentity({
    provider: "linear_user",
    externalId: `${orgId}:${creator.id}`,
    handle: creator.id,
    displayName: creator.name || creator.displayName || creator.email || "Linear user",
    email: creator.email,
    avatarUrl: creator.avatarUrl ?? undefined,
    reactivate: false,
  });
  const issue = await client.issue(issueId);
  const team = await issue.team;
  if (!team) {
    await respond("I could not determine this issue's team.");
    return;
  }
  await ingestLinearIssueObject(orgId, issue, client);
  const resource = await db.getConnectorResource(connector.connectorId, "team", team.id);
  const linkRequested = /^link\s*$/i.test(directPrompt(webhook));
  const requiredPermission = linkRequested ? "connectors.manage" : "chat.use";
  const allowed = resource && await enterprise.userCan(user.userId, connector.workspaceId, requiredPermission, {
    connectorProvider: "linear",
    resourceId: resource.resourceId,
    sourceType: "issue",
  });
  if (!allowed) {
    await respond(linkRequested
      ? "Only an Orin owner or administrator can create a workspace link code."
      : "You do not have Orin chat access for this workspace and team. Ask an administrator to update your access.");
    return;
  }
  if (linkRequested && !linearAdministrator(creator)) {
    await respond("Only a current Linear owner or administrator can create a workspace link code.");
    return;
  }
  const rateLimit = await enterprise.consumeRateLimit({
    workspaceId: connector.workspaceId,
    userId: user.userId,
    action: linkRequested ? "linear.link" : "linear.chat",
    limit: linkRequested ? 5 : 20,
    windowSeconds: 60,
  });
  if (!rateLimit.allowed) {
    await respond(`Too many requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`);
    return;
  }
  if (!linearInlineAnswerAllowed(issue)) {
    await respond(`This issue has individual sharing enabled, so I will not post workspace knowledge into its comments. Use ${process.env.WEB_ORIGIN ?? "the Orin dashboard"} for a private, personalized answer.`);
    return;
  }
  if (linkRequested) {
    const code = randomBytes(16).toString("hex").toUpperCase();
    await db.insertLinkCode(createHash("sha256").update(code).digest("hex"), "linear", orgId, 15);
    await enterprise.recordAuditEvent({
      workspaceId: connector.workspaceId,
      actorUserId: user.userId,
      action: "connector.link_code_created",
      targetType: "connector",
      targetId: connector.connectorId,
      details: { provider: "linear", teamId: team.id },
    });
    await respond(
      `Link code: \`${code}\` (expires in 15 minutes and can be used once).\n\n` +
      `Have an active GitHub organization owner comment \`@orinbot link ${code}\` on an issue or pull request in the organization to connect.`,
    );
    return;
  }
  const question = sessionQuestion(webhook);
  if (!question) {
    await respond("Ask a question and I will search the Linear issues this team is allowed to access.");
    return;
  }
  const found = await content.authorizedSearch({
    workspaceId: connector.workspaceId,
    userId: user.userId,
    permission: "chat.use",
    query: question,
    provider: "linear",
    resourceId: resource.resourceId,
    limit: 8,
  });
  const currentItems = await content.getAuthorizedItemsByIds({
    workspaceId: connector.workspaceId,
    userId: user.userId,
    permission: "chat.use",
    itemIds: found.map((item) => item.itemId),
  });
  const currentById = new Map(currentItems.map((item) => [item.itemId, item]));
  const evidence = found.map((item) => currentById.get(item.itemId)).filter((item) => item !== undefined);
  const answer = await answerQuestion(question, evidence);
  const rechecked = await content.getAuthorizedItemsByIds({
    workspaceId: connector.workspaceId,
    userId: user.userId,
    permission: "chat.use",
    itemIds: evidence.map((item) => item.itemId),
  });
  const allowedIds = new Set(rechecked.map((item) => item.itemId));
  if (evidence.some((item) => !allowedIds.has(item.itemId))) {
    await respond("Your source access changed while I was answering. Please ask again.");
    return;
  }
  const latestIssue = await client.issue(issueId);
  const latestTeam = await latestIssue.team;
  if (!linearInlineAnswerAllowed(latestIssue)) {
    await respond(`This issue now has individual sharing enabled, so I will not post workspace knowledge into its comments. Use ${process.env.WEB_ORIGIN ?? "the Orin dashboard"} for a private, personalized answer.`);
    return;
  }
  if (!latestTeam || latestTeam.id !== team.id) {
    await respond("This issue's team changed while I was answering. Please ask again so I can apply the new access rules.");
    return;
  }
  await enterprise.recordAuditEvent({
    workspaceId: connector.workspaceId,
    actorUserId: user.userId,
    action: "chat.answer",
    targetType: "linear_issue",
    targetId: issueId,
    details: { provider: "linear", teamId: team.id, sourceCount: evidence.length },
  });
  await respond(responseWithSources(answer, evidence));
}

async function failRemovedTeamAccess(orgId: string, teamIds: string[]): Promise<void> {
  const connector = await db.getConnector("linear", orgId);
  if (!connector) return;
  for (const teamId of [...new Set(teamIds.filter(Boolean))]) {
    const resource = await db.getConnectorResource(connector.connectorId, "team", teamId);
    if (resource) await content.markConnectorResourceAclStatus(connector.workspaceId, resource.resourceId, "failed");
  }
}

export async function processLinearWebhook(webhookInput: Record<string, unknown>): Promise<void> {
  if (typeof webhookInput.type !== "string") return;
  const webhook = webhookInput as unknown as WebhookBase;
  const orgId = webhook.organizationId;
  if (!orgId) return;
  if (webhook.type === "OAuthApp" && webhook.action === "revoked") {
    await disableLinearConnector(orgId);
    return;
  }
  if ((webhook.type === "PermissionChange" && webhook.action === "teamAccessChanged")
    || webhook.type === "AppUserTeamAccessChanged") {
    await failRemovedTeamAccess(orgId, (webhook as AppTeamAccessWebhook).removedTeamIds ?? []);
    return;
  }
  if (webhook.type === "User" || webhook.type === "Team") {
    const connector = await db.getConnector("linear", orgId);
    if (connector) await content.markConnectorResourcesAclStatus(connector.workspaceId, connector.connectorId, "stale");
    return;
  }
  const client = await clientForOrg(orgId);
  if (!client) {
    console.warn("linear: no installation for organization", orgId);
    return;
  }
  if (webhook.type === "AgentSessionEvent" && (webhook.action === "created" || webhook.action === "prompted")) {
    await handleSession(client, webhook as AgentSessionWebhook);
    return;
  }
  if (webhook.type === "Issue") {
    const event = webhook as IssueWebhook;
    if (!event.data?.id) return;
    if (event.action === "remove") await deleteLinearIssue(orgId, event.data.id);
    else if (event.action === "create" || event.action === "update") await ingestLinearIssue(orgId, event.data.id, client);
    return;
  }
  if (webhook.type === "Comment") {
    const event = webhook as CommentWebhook;
    if (event.data?.issueId) await ingestLinearIssue(orgId, event.data.issueId, client);
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const webhookSecret = reqEnv("LINEAR_WEBHOOK_SECRET");
  const oauthSecret = config.secret;
  const port = Number(process.env.LINEAR_PORT ?? 3002);
  const boss = new PgBoss(config.databaseUrl);
  await boss.start();
  await boss.createQueue(QUEUE.linearWebhook);
  createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\/linear(?=\/|$)/, "") || "/";
    if (req.method === "GET" && path === "/install") {
      handleLinearInstall(req, res, oauthSecret);
      return;
    }
    if (req.method === "GET" && path === "/oauth") {
      void handleOAuthCallback(req, res, oauthSecret, boss).catch((error) => {
        console.error("linear oauth error:", error instanceof Error ? error.message : String(error));
        html(res, 500, "<h2>Orin</h2><p>Install failed. Check the server logs and try again.</p>", { "Set-Cookie": installCookie("", 0) });
      });
      return;
    }
    if (req.method !== "POST" || path !== "/") {
      res.writeHead(404).end();
      return;
    }
    void readBody(req, 2_000_000).then(async (raw) => {
      const signature = String(req.headers["linear-signature"] ?? "");
      if (!verifyLinearWebhook(webhookSecret, raw, signature)) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid webhook" }));
        return;
      }
      const webhook = JSON.parse(raw) as WebhookBase & Record<string, unknown>;
      const deliveryId = typeof webhook.webhookId === "string" && webhook.webhookId
        ? webhook.webhookId
        : createHash("sha256").update(raw).digest("hex");
      await boss.send(QUEUE.linearWebhook, { webhook } satisfies LinearWebhookJob, {
        singletonKey: deliveryId,
        singletonSeconds: 24 * 60 * 60,
        retryLimit: 5,
        retryDelay: 10,
        retryBackoff: true,
      });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    }).catch((error) => {
      if (!res.headersSent) {
        const tooLarge = error instanceof Error && error.message === "payload too large";
        res.writeHead(tooLarge ? 413 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: tooLarge ? "payload too large" : "temporarily unavailable" }));
      }
    });
  }).listen(port, () => console.log(`orin-linear listening on :${port}`));
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("linear.js") || entry.endsWith("linear.ts")) {
  main().catch((error) => {
    console.error(`orin-linear: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
