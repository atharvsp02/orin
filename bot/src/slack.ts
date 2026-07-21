// Orin Slack adapter (Bolt) — thin over the decision core. Multi-workspace OAuth: every new
// workspace is auto-provisioned its OWN isolated brain on install, and can later switch to a
// GitHub installation's memory via the one-time link-code flow (`/orin link` → `@orin link CODE`).
import { createHash, randomBytes } from "node:crypto";
import bolt from "@slack/bolt";
import type { Installation, InstallationQuery } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { can, canPotentially, type WorkspacePermission } from "./access.js";
import { connectorSupports, type ConnectorAccount, type ConnectorResource } from "./connectors.js";
import * as content from "./content-db.js";
import * as db from "./db.js";
import * as enterprise from "./enterprise-db.js";
import * as llm from "./llm.js";
import { safeJobError } from "./queues.js";
import { resolveTenant, provisionAndLink } from "./tenant.js";
import type { Tenant } from "./tenant.js";
import * as prim from "./primitives.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const { App } = bolt;

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Slack adapter needs ${name}`);
  return v;
}

const idOf = (q: { isEnterpriseInstall?: boolean; enterpriseId?: string; teamId?: string }): string =>
  (q.isEnterpriseInstall && q.enterpriseId ? q.enterpriseId : q.teamId) ?? "";

export function slackInstallerEligible(value: unknown): boolean {
  const user = objectValue(value);
  return Boolean(
    user && !user.deleted && !user.is_bot &&
    (user.is_admin || user.is_owner || user.is_primary_owner),
  );
}

async function bootstrapSlackInstaller(installation: Installation, teamId: string, workspaceId: string): Promise<void> {
  const installerId = installation.user?.id;
  const botToken = installation.bot?.token;
  if (!installerId || !botToken) return;
  const client = new WebClient(botToken);
  const response = await client.users.info({ user: installerId });
  const slackUser = objectValue(response.user);
  const profile = objectValue(slackUser?.profile);
  const email = typeof profile?.email === "string" ? profile.email.trim().toLowerCase() : "";
  if (!slackInstallerEligible(slackUser) || !email) return;
  const user = await enterprise.upsertUserIdentity({
    provider: "slack_user",
    externalId: `${teamId}:${installerId}`,
    handle: installerId,
    displayName: typeof profile?.real_name === "string" && profile.real_name.trim()
      ? profile.real_name.trim()
      : email.split("@")[0],
    email,
    avatarUrl: typeof profile?.image_192 === "string" ? profile.image_192 : undefined,
    reactivate: false,
  });
  if (user.status !== "active") return;
  const membership = await enterprise.bootstrapWorkspaceMembership(user.userId, workspaceId);
  if (membership.status !== "active") return;
  await enterprise.recordAuditEvent({
    workspaceId,
    actorUserId: user.userId,
    action: "membership.bootstrapped",
    targetType: "user",
    targetId: user.userId,
    details: { provider: "slack", role: membership.role },
  });
}

async function slackOwnedWorkspace(workspaceId: string): Promise<boolean> {
  const workspace = await db.getWorkspace(workspaceId);
  if (workspace?.legacyInstallationId === undefined) return false;
  const installation = await db.getInstallation(workspace.legacyInstallationId);
  return installation?.githubAccount.startsWith("slack:") ?? false;
}

const installationStore = {
  async storeInstallation(installation: Installation): Promise<void> {
    const id = installation.isEnterpriseInstall && installation.enterprise ? installation.enterprise.id : installation.team?.id;
    if (!id) throw new Error("Slack installation has no team/enterprise id");
    await db.storeSlackInstall(id, installation);
    const existing = await db.getConnector("slack", id);
    let workspaceId = existing?.workspaceId;
    if (existing) await db.setConnectorEnabled(existing.workspaceId, existing.connectorId, true);
    else {
      try {
        const tenant = await provisionAndLink({ provider: "slack", externalId: id }, `slack:${installation.team?.name ?? id}`);
        workspaceId = tenant.workspaceId;
      } catch (error) {
        console.error("slack auto-provision failed:", safeJobError(error));
      }
    }
    if (workspaceId && await slackOwnedWorkspace(workspaceId)) {
      const hasActiveMember = (await enterprise.listMemberships(workspaceId)).some((membership) => membership.status === "active");
      if (!hasActiveMember) {
        await bootstrapSlackInstaller(installation, id, workspaceId).catch((error) => {
          console.error("Slack owner bootstrap failed:", safeJobError(error));
        });
      }
    }
  },
  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation> {
    const data = await db.fetchSlackInstall(idOf(query));
    if (!data) throw new Error("no Slack installation");
    return data as Installation;
  },
  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const id = idOf(query);
    await db.deleteSlackInstall(id);
    const connector = await db.getConnector("slack", id);
    if (connector) {
      await content.markConnectorAclStale(connector.workspaceId, connector.connectorId);
      await content.markConnectorResourcesAclStatus(connector.workspaceId, connector.connectorId, "stale");
      await db.setConnectorEnabled(connector.workspaceId, connector.connectorId, false);
    }
  },
};

const tenantForTeam = (teamId?: string): Promise<Tenant | null> =>
  resolveTenant({ provider: "slack", externalId: teamId ?? "" });

function slackContextIds(value: unknown): string[] {
  const context = objectValue(value);
  return [...new Set([
    typeof context?.team_id === "string" ? context.team_id : "",
    typeof context?.enterprise_id === "string" ? context.enterprise_id : "",
  ].filter(Boolean))];
}

async function slackContextId(value: unknown): Promise<string> {
  const ids = slackContextIds(value);
  for (const id of ids) {
    if (await db.getConnector("slack", id)) return id;
  }
  return ids[0] ?? "";
}

interface SlackActor {
  teamId: string;
  access: enterprise.WorkspaceAccess;
}

interface SlackClientLike {
  conversations: {
    info(args: { channel: string }): Promise<unknown>;
    members(args: { channel: string; cursor?: string; limit: number }): Promise<unknown>;
  };
  users: {
    list(args: { cursor?: string; limit: number }): Promise<unknown>;
  };
}

interface SlackMessageChange {
  kind: "upsert" | "delete";
  channelId: string;
  timestamp: string;
  text?: string;
  userId?: string;
  threadTimestamp?: string;
}

interface SlackChannelState {
  resource: ConnectorResource;
  name: string;
  private: boolean;
}

const directoryCache = new Map<string, { expiresAt: number }>();
const channelCache = new Map<string, { expiresAt: number; state: SlackChannelState }>();
const refreshingTeams = new Set<string>();
const refreshingChannels = new Map<string, Promise<SlackChannelState | null>>();

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeSlackMessage(value: unknown): SlackMessageChange | null {
  const event = objectValue(value);
  if (!event || typeof event.channel !== "string" || !event.channel.trim()) return null;
  const channelId = event.channel.trim();
  if (event.subtype === "message_deleted") {
    const timestamp = typeof event.deleted_ts === "string" ? event.deleted_ts : "";
    return /^\d+\.\d+$/.test(timestamp) ? { kind: "delete", channelId, timestamp } : null;
  }
  const message = event.subtype === "message_changed" ? objectValue(event.message) : event;
  if (!message || message.bot_id || message.subtype === "bot_message") return null;
  const timestamp = typeof message.ts === "string" ? message.ts : "";
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const userId = typeof message.user === "string" ? message.user.trim() : "";
  if (!/^\d+\.\d+$/.test(timestamp) || !text || !userId) return null;
  return {
    kind: "upsert",
    channelId,
    timestamp,
    text,
    userId,
    threadTimestamp: typeof message.thread_ts === "string" ? message.thread_ts : undefined,
  };
}

export function slackMembershipAcls(teamId: string, memberIds: string[]): content.ContentAcl[] {
  const principals = new Map<string, content.ContentAcl>();
  for (const memberId of memberIds) {
    const userId = memberId.trim();
    if (!userId) continue;
    const key = `${teamId}:${userId}`;
    principals.set(`slack_user:${key.toLowerCase()}`, { principalType: "slack_user", principalKey: key });
  }
  return [...principals.values()];
}

async function slackDirectory(client: SlackClientLike, teamId: string): Promise<void> {
  const cached = directoryCache.get(teamId);
  if (cached && cached.expiresAt > Date.now()) return;
  const identities = new Map<string, { email: string; displayName: string; avatarUrl?: string }>();
  let cursor = "";
  const seen = new Set<string>();
  do {
    const response = objectValue(await client.users.list({ cursor: cursor || undefined, limit: 200 }));
    const members = Array.isArray(response?.members) ? response.members : [];
    for (const memberValue of members) {
      const member = objectValue(memberValue);
      const profile = objectValue(member?.profile);
      if (member?.deleted || typeof member?.id !== "string" || typeof profile?.email !== "string") continue;
      const email = profile.email.trim().toLowerCase();
      if (email) identities.set(member.id, {
        email,
        displayName: typeof profile.real_name === "string" && profile.real_name.trim()
          ? profile.real_name.trim()
          : typeof member.name === "string" && member.name.trim() ? member.name.trim() : email.split("@")[0],
        avatarUrl: typeof profile.image_192 === "string" ? profile.image_192 : undefined,
      });
    }
    const metadata = objectValue(response?.response_metadata);
    const next = typeof metadata?.next_cursor === "string" ? metadata.next_cursor.trim() : "";
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  } while (true);
  const entries = [...identities.entries()];
  for (let offset = 0; offset < entries.length; offset += 20) {
    await Promise.all(entries.slice(offset, offset + 20).map(([userId, identity]) => enterprise.upsertUserIdentity({
      provider: "slack_user",
      externalId: `${teamId}:${userId}`,
      handle: userId,
      displayName: identity.displayName,
      email: identity.email,
      avatarUrl: identity.avatarUrl,
      reactivate: false,
    })));
  }
  directoryCache.set(teamId, { expiresAt: Date.now() + 10 * 60_000 });
}

async function slackActor(
  context: unknown,
  slackUserId: string,
  client: SlackClientLike,
): Promise<SlackActor | null> {
  const teamId = await slackContextId(context);
  if (!teamId || !slackUserId) return null;
  const connector = await db.getConnector("slack", teamId);
  if (!connector || connector.status !== "active") return null;
  try {
    await slackDirectory(client, teamId);
  } catch {
    return null;
  }
  const user = await enterprise.getUserByIdentity("slack_user", `${teamId}:${slackUserId}`);
  if (!user) return null;
  const access = await enterprise.getWorkspaceAccess(user.userId, connector.workspaceId);
  return access ? { teamId, access } : null;
}

async function legacyMemoryAllowed(
  tenant: Tenant,
  access: enterprise.WorkspaceAccess,
  permission: Extract<WorkspacePermission, "search.use" | "chat.use">,
): Promise<boolean> {
  if (access.grants.some((grant) =>
    grant.permission === permission && (grant.conditions?.resourceId !== undefined || grant.conditions?.sourceType !== undefined)
  )) return false;
  const github = await db.getConnector("github", String(tenant.installationId));
  if (!github || github.workspaceId !== tenant.workspaceId || github.status !== "active") return false;
  if (!can(access.membership.role, permission, access.grants, { connectorProvider: "github" })) return false;
  const resources = await db.listConnectorResources(github.connectorId);
  if (resources.some((resource) => !resource.enabled)) return false;
  const [records, docs] = await Promise.all([
    db.getDecisionRecords(tenant.installationId),
    db.listDocs(tenant.installationId),
  ]);
  return records.every((record) => Boolean(record.repo)) && docs.every((doc) => Boolean(doc.repo));
}

function slackAnswerWithSources(answer: string, results: content.SearchResult[]): string {
  if (results.length === 0) return answer;
  const sources = results.map((result, index) => {
    const label = result.title.replace(/[<>]/g, "").slice(0, 120);
    return result.url ? `[${index + 1}] <${result.url}|${label}>` : `[${index + 1}] ${label}`;
  });
  return `${answer}\n\nSources: ${sources.join("  ")}`;
}

async function answerSlackQuestion(input: {
  context: unknown;
  slackUserId: string;
  client: SlackClientLike;
  question: string;
}): Promise<string> {
  const actor = await slackActor(input.context, input.slackUserId, input.client);
  if (!actor || !canPotentially(actor.access.membership.role, "chat.use", actor.access.grants)) {
    return "Your Orin workspace membership does not allow Ask Orin. Ask a workspace owner to invite your Slack email and enable chat access.";
  }
  const rate = await enterprise.consumeRateLimit({
    workspaceId: actor.access.membership.workspaceId,
    userId: actor.access.user.userId,
    action: "slack-chat",
    limit: 20,
  });
  if (!rate.allowed) return `Too many requests. Try again in ${rate.retryAfterSeconds} seconds.`;
  const question = input.question.replace(/\s+/g, " ").trim().slice(0, 500) || "Summarize the most relevant past decision and why it was made.";
  let results = await content.authorizedSearch({
    workspaceId: actor.access.membership.workspaceId,
    userId: actor.access.user.userId,
    permission: "chat.use",
    query: question,
    limit: 8,
  });
  let answer: string;
  let usedLegacy = false;
  if (results.length > 0) {
    answer = await llm.answerQuestion(question, results.map((result) => ({
      title: result.title,
      snippet: result.snippet,
      provider: result.provider,
      url: result.url,
    })));
    const current = await content.getAuthorizedItemsByIds({
      workspaceId: actor.access.membership.workspaceId,
      userId: actor.access.user.userId,
      itemIds: results.map((result) => result.itemId),
      permission: "chat.use",
    });
    if (current.length !== results.length) {
      results = [];
      answer = "Your source access changed while I was answering. Please ask again.";
    }
  } else {
    const tenant = await tenantForTeam(actor.teamId);
    if (tenant && await legacyMemoryAllowed(tenant, actor.access, "chat.use")) {
      usedLegacy = true;
      answer = await prim.ask(tenant, question);
      const currentAccess = await enterprise.getWorkspaceAccess(actor.access.user.userId, tenant.workspaceId);
      if (!currentAccess || !await legacyMemoryAllowed(tenant, currentAccess, "chat.use")) {
        answer = "Your source access changed while I was answering. Please ask again.";
      }
    } else answer = "I could not find enough information in the sources you are allowed to access.";
  }
  await enterprise.recordAuditEvent({
    workspaceId: actor.access.membership.workspaceId,
    actorUserId: actor.access.user.userId,
    action: "slack.chat_answered",
    targetType: "knowledge",
    targetId: actor.teamId,
    details: { resultItemIds: results.map((result) => result.itemId), usedLegacy },
  });
  return slackAnswerWithSources(answer || "No relevant decision found in memory.", results);
}

async function safeSlackAnswer(input: Parameters<typeof answerSlackQuestion>[0]): Promise<string> {
  try {
    return await answerSlackQuestion(input);
  } catch (error) {
    console.error("Slack answer failed:", safeJobError(error));
    return "Ask Orin is temporarily unavailable. Please try again.";
  }
}

async function channelMembers(client: SlackClientLike, channelId: string): Promise<string[]> {
  const members = new Set<string>();
  let cursor = "";
  const seen = new Set<string>();
  do {
    const response = objectValue(await client.conversations.members({ channel: channelId, cursor: cursor || undefined, limit: 200 }));
    for (const member of Array.isArray(response?.members) ? response.members : []) {
      if (typeof member === "string" && member.trim()) members.add(member.trim());
    }
    const metadata = objectValue(response?.response_metadata);
    const next = typeof metadata?.next_cursor === "string" ? metadata.next_cursor.trim() : "";
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  } while (true);
  return [...members];
}

async function syncSlackChannelAccessNow(input: {
  teamId: string;
  channelId: string;
  connector: ConnectorAccount;
  client: SlackClientLike;
  force?: boolean;
}): Promise<SlackChannelState | null> {
  const cacheKey = `${input.teamId}:${input.channelId}`;
  const cached = channelCache.get(cacheKey);
  if (!input.force && cached && cached.expiresAt > Date.now()) return cached.state;
  let resource = cached?.state.resource ?? await db.getConnectorResource(input.connector.connectorId, "channel", input.channelId) ?? undefined;
  try {
    const response = objectValue(await input.client.conversations.info({ channel: input.channelId }));
    const channel = objectValue(response?.channel);
    if (!channel) throw new Error("Slack returned no channel details");
    if (channel.is_im || channel.is_mpim) {
      if (resource) await db.setConnectorResourceEnabled(input.connector.workspaceId, resource.resourceId, false);
      channelCache.delete(cacheKey);
      return null;
    }
    if (channel.is_member !== true) {
      if (resource) await content.markConnectorResourceAclStatus(input.connector.workspaceId, resource.resourceId, "failed");
      channelCache.delete(cacheKey);
      return null;
    }
    if (channel.is_archived) {
      if (resource) await db.setConnectorResourceEnabled(input.connector.workspaceId, resource.resourceId, false);
      channelCache.delete(cacheKey);
      return null;
    }
    const name = typeof channel.name === "string" && channel.name.trim() ? channel.name.trim() : input.channelId;
    resource = await db.upsertConnectorResource({
      connectorId: input.connector.connectorId,
      externalId: input.channelId,
      kind: "channel",
      displayName: name,
    });
    const members = await channelMembers(input.client, input.channelId);
    await slackDirectory(input.client, input.teamId);
    await content.replaceConnectorResourceMemberships(
      input.connector.workspaceId,
      resource.resourceId,
      slackMembershipAcls(input.teamId, members),
    );
    const state = { resource: { ...resource, aclStatus: "current" as const }, name, private: Boolean(channel.is_private) };
    channelCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, state });
    return state;
  } catch (error) {
    if (resource) await content.markConnectorResourceAclStatus(input.connector.workspaceId, resource.resourceId, "failed");
    channelCache.delete(cacheKey);
    throw error;
  }
}

async function syncSlackChannelAccess(input: {
  teamId: string;
  channelId: string;
  connector: ConnectorAccount;
  client: SlackClientLike;
  force?: boolean;
}): Promise<SlackChannelState | null> {
  const key = `${input.teamId}:${input.channelId}`;
  const previous = refreshingChannels.get(key);
  const refresh = (previous ? previous.catch(() => null) : Promise.resolve()).then(() => syncSlackChannelAccessNow(input));
  refreshingChannels.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshingChannels.get(key) === refresh) refreshingChannels.delete(key);
  }
}

function slackTimestamp(value: string): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

export async function ingestSlackMessageEvent(
  teamId: string,
  value: unknown,
  client: SlackClientLike,
): Promise<"written" | "deleted" | "skipped"> {
  const change = normalizeSlackMessage(value);
  if (!change || !teamId) return "skipped";
  const connector = await db.getConnector("slack", teamId);
  if (!connector || !connectorSupports(connector, "ingest")) return "skipped";
  const externalId = `${change.channelId}:${change.timestamp}`;
  if (change.kind === "delete") {
    return await content.markContentDeleted(connector.workspaceId, connector.connectorId, externalId) ? "deleted" : "skipped";
  }
  const channel = await syncSlackChannelAccess({ teamId, channelId: change.channelId, connector, client });
  if (!channel?.resource.enabled) return "skipped";
  const allowed = await content.connectorContentAllowed(connector.workspaceId, connector.connectorId, {
    provider: "slack",
    resourceId: change.channelId,
    owner: change.userId ?? "",
    mimeType: "text/plain",
    path: `#${channel.name}`,
    sourceType: "message",
  });
  if (!allowed) {
    return await content.markContentDeleted(connector.workspaceId, connector.connectorId, externalId) ? "deleted" : "skipped";
  }
  await content.upsertContentItem({
    workspaceId: connector.workspaceId,
    connectorId: connector.connectorId,
    resourceId: channel.resource.resourceId,
    externalId,
    sourceType: "message",
    title: change.text!.split("\n")[0].slice(0, 160),
    body: change.text!,
    mimeType: "text/plain",
    ownerKey: change.userId,
    sourcePath: `#${channel.name}`,
    visibility: "restricted",
    aclStatus: "current",
    acls: [{ principalType: "resource_member", principalKey: channel.resource.resourceId }],
    sourceCreatedAt: slackTimestamp(change.timestamp),
    sourceUpdatedAt: new Date().toISOString(),
    metadata: {
      teamId,
      channelId: change.channelId,
      messageTimestamp: change.timestamp,
      threadTimestamp: change.threadTimestamp ?? "",
      channelPrivate: channel.private,
    },
  });
  return "written";
}

async function refreshSlackWorkspaceAccess(teamId: string): Promise<void> {
  if (refreshingTeams.has(teamId)) return;
  refreshingTeams.add(teamId);
  try {
    const connector = await db.getConnector("slack", teamId);
    if (!connector || !connectorSupports(connector, "ingest")) return;
    const installation = objectValue(await db.fetchSlackInstall(teamId));
    const bot = objectValue(installation?.bot);
    if (typeof bot?.token !== "string" || !bot.token) {
      await content.markConnectorResourcesAclStatus(connector.workspaceId, connector.connectorId, "failed");
      throw new Error("Slack installation has no bot token");
    }
    const client = new WebClient(bot.token) as unknown as SlackClientLike;
    const resources = (await db.listConnectorResources(connector.connectorId)).filter((resource) => resource.kind === "channel");
    for (const resource of resources) {
      await syncSlackChannelAccess({
        teamId,
        channelId: resource.externalId,
        connector,
        client,
        force: true,
      }).catch((error) => console.error(`Slack ACL refresh failed for ${teamId}:${resource.externalId}:`, (error as Error).message));
    }
  } finally {
    refreshingTeams.delete(teamId);
  }
}

async function refreshAllSlackWorkspaceAccess(): Promise<void> {
  for (const teamId of await db.listSlackInstallationIds()) {
    await refreshSlackWorkspaceAccess(teamId).catch((error) => {
      console.error(`Slack ACL refresh failed for ${teamId}:`, (error as Error).message);
    });
  }
}

function buildApp(): InstanceType<typeof App> {
  const app = new App({
    signingSecret: reqEnv("SLACK_SIGNING_SECRET"),
    clientId: reqEnv("SLACK_CLIENT_ID"),
    clientSecret: reqEnv("SLACK_CLIENT_SECRET"),
    stateSecret: reqEnv("SLACK_STATE_SECRET"), // signs the OAuth state param — must not be a known default (CSRF)
    scopes: [
      "commands",
      "chat:write",
      "reactions:read",
      "channels:history",
      "channels:read",
      "groups:history",
      "groups:read",
      "app_mentions:read",
      "users:read",
      "users:read.email",
    ],
    installationStore,
  });
  registerHandlers(app);
  return app;
}

// Workspace-admin check (needs users:read). Fail closed: unknown → not admin.
async function isWorkspaceAdmin(client: { users: { info: (a: { user: string }) => Promise<{ user?: { is_admin?: boolean; is_owner?: boolean; is_primary_owner?: boolean } }> } }, userId: string): Promise<boolean> {
  try {
    const { user } = await client.users.info({ user: userId });
    return Boolean(user?.is_admin || user?.is_owner || user?.is_primary_owner);
  } catch {
    return false;
  }
}

// Cheap gate so we don't run the LLM on ordinary chatter — only on proposal-shaped messages.
function looksLikeProposal(text: string): boolean {
  return /\b(should we|let'?s|propose|switch to|migrate to|introduce|add (a|the)?\s?\w+ (dependency|library|package)|use \w+ instead)\b/i.test(
    text,
  );
}

function registerHandlers(app: InstanceType<typeof App>): void {
  // /why [repo:owner/name] <question> — ack fast (<3s), then answer with a cited message.
  // A workspace linked to a GitHub org holds ALL that org's repos in one memory; the repo:
  // token narrows the question to one of them.
  app.command("/why", async ({ command, ack, respond, client }) => {
    await ack();
    const raw = command.text?.trim() ?? "";
    const repo = raw.match(/\brepo:(\S+)/i)?.[1];
    let question = raw.replace(/\brepo:\S+\s*/i, "").trim();
    if (!question) question = "Summarize the most relevant past decision and why it was made.";
    const answer = await safeSlackAnswer({
      context: command,
      slackUserId: command.user_id,
      client: client as unknown as SlackClientLike,
      question: repo ? `In repository ${repo}: ${question}` : question,
    });
    await respond({
      response_type: "ephemeral",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: answer || "No relevant decision found in memory." } }],
    });
  });

  // /orin — workspace management: link to a GitHub org's memory, status, repos, unlink, help.
  // link/unlink change what memory the whole workspace uses → workspace admins only.
  app.command("/orin", async ({ command, ack, respond, client }) => {
    await ack();
    const teamId = await slackContextId(command);
    const [sub = "help", ...rest] = (command.text ?? "").trim().split(/\s+/);
    const ephemeral = (text: string) => respond({ response_type: "ephemeral", text });
    const actor = () => slackActor(command, command.user_id, client as unknown as SlackClientLike);
    const requireAdmin = async (): Promise<boolean> => {
      if (await isWorkspaceAdmin(client, command.user_id)) return true;
      await ephemeral("⛔ `link` and `unlink` change this workspace's memory — workspace admins only.");
      return false;
    };
    const requireMember = async (): Promise<SlackActor | null> => {
      const current = await actor();
      if (current && can(current.access.membership.role, "workspace.read", current.access.grants)) return current;
      await ephemeral("Your Slack email is not an active member of this Orin workspace.");
      return null;
    };

    switch (sub.toLowerCase()) {
      case "link": {
        if (!(await requireAdmin())) break;
        // Mint a one-time code bound to this workspace for a GitHub administrator to approve.
        // 16 bytes = 128-bit entropy (hex keeps it case-insensitive for the consume side); combined
        // with single-use + 15-min expiry + every guess being a public GitHub comment, unguessable.
        const code = randomBytes(16).toString("hex").toUpperCase();
        await db.insertLinkCode(sha256(code), "slack", teamId, 15);
        await ephemeral(
          `🔗 Link code: \`${code}\` (expires in 15 minutes, single-use).\n` +
            `Have an active GitHub organization owner comment \`@orin link ${code}\` on any issue/PR in the organization you want to connect. ` +
            `That replaces this workspace's current memory with the org's decision memory.`,
        );
        break;
      }
      case "status": {
        const member = await requireMember();
        if (!member) break;
        const tenant = await tenantForTeam(teamId);
        if (!tenant) {
          await ephemeral("No memory linked. Reinstall the app to auto-provision one, or run `/orin link`.");
          break;
        }
        if (!await legacyMemoryAllowed(tenant, member.access, "search.use")) {
          await ephemeral("Memory is connected. Use Ask Orin to see only the sources your access policy allows.");
          break;
        }
        const [count, repos] = await Promise.all([
          db.countDecisions(tenant.installationId),
          db.distinctRepos(tenant.installationId),
        ]);
        const kind = tenant.inst.githubAccount.startsWith("slack:") ? "own workspace memory" : `GitHub memory of *${tenant.inst.githubAccount}*`;
        await ephemeral(`📊 Linked to ${kind} — ${count} decisions${repos.length ? ` across: ${repos.join(", ")}` : ""}.`);
        break;
      }
      case "repos": {
        const member = await requireMember();
        if (!member) break;
        const tenant = await tenantForTeam(teamId);
        if (tenant && !await legacyMemoryAllowed(tenant, member.access, "search.use")) {
          await ephemeral("Repository listing is unavailable under the current scoped access policy. Use permission-aware search instead.");
          break;
        }
        const repos = tenant ? await db.distinctRepos(tenant.installationId) : [];
        await ephemeral(repos.length ? `Repos with recorded decisions:\n${repos.map((r) => `• \`${r}\` — try \`/why repo:${r} …\``).join("\n")}` : "No repo-scoped decisions yet.");
        break;
      }
      case "unlink": {
        if (!(await requireAdmin())) break;
        // Detach from the current memory and provision a fresh, empty one for this workspace.
        await db.unlinkTenant("slack", teamId);
        await provisionAndLink({ provider: "slack", externalId: teamId }, `slack:${teamId}`);
        await ephemeral("🧹 Unlinked. This workspace now has its own fresh, empty memory.");
        break;
      }
      default:
        void rest;
        await ephemeral(
          "*Orin commands*\n" +
            "• `/why [repo:owner/name] <question>` — ask why a decision was made\n" +
            "• `/orin link` — get a code to connect this workspace to a GitHub org's memory\n" +
            "• `/orin status` — what memory this workspace uses\n" +
            "• `/orin repos` — repos with recorded decisions\n" +
            "• `/orin unlink` — detach and start a fresh workspace memory\n" +
            "• React with :brain: on any message to record it as a decision",
        );
    }
  });

  // @Orin <question> in a channel answers like /why (mention-driven recall).
  app.event("app_mention", async ({ event, body, client }) => {
    if (!event.user || !event.channel) return;
    const question = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
    const answer = await safeSlackAnswer({
      context: body,
      slackUserId: event.user,
      client: client as unknown as SlackClientLike,
      question,
    });
    await client.chat.postEphemeral({ channel: event.channel, user: event.user, thread_ts: event.ts, text: answer });
  });

  // React with :brain: (or SLACK_INGEST_EMOJI) on a message to record it into memory.
  app.event("reaction_added", async ({ event, client, body }) => {
    if (event.reaction !== (process.env.SLACK_INGEST_EMOJI ?? "brain")) return;
    if (event.item.type !== "message") return;
    const actor = await slackActor(body, event.user, client as unknown as SlackClientLike);
    if (!actor) {
      await client.chat.postEphemeral({
        channel: event.item.channel,
        user: event.user,
        text: "Your Slack email is not an active member of this Orin workspace.",
      });
      return;
    }
    const connector = await db.getConnector("slack", actor.teamId);
    const channel = connector ? await syncSlackChannelAccess({
      teamId: actor.teamId,
      channelId: event.item.channel,
      connector,
      client: client as unknown as SlackClientLike,
    }) : null;
    if (!channel || !can(actor.access.membership.role, "content.manage", actor.access.grants, {
      connectorProvider: "slack",
      resourceId: channel.resource.resourceId,
      sourceType: "message",
    })) {
      await client.chat.postEphemeral({
        channel: event.item.channel,
        user: event.user,
        text: "You do not have permission to record decisions from this channel.",
      });
      return;
    }
    const tenant = await tenantForTeam(actor.teamId);
    if (!tenant) return;
    try {
      const res = await client.conversations.history({ channel: event.item.channel, latest: event.item.ts, inclusive: true, limit: 1 });
      const text = res.messages?.[0]?.text;
      if (!text) return;
      await prim.ingest(tenant, {
        kind: "doc",
        number: Number(event.item.ts.replace(".", "")),
        title: text.slice(0, 80),
        body: text,
        url: "",
        repo: "",
      });
    } catch (error) {
      console.error("Slack decision recording failed:", safeJobError(error));
      await client.chat.postEphemeral({
        channel: event.item.channel,
        user: event.user,
        text: "Orin could not record this decision. Please try again.",
      });
    }
  });

  const refreshChannelAccess = async (body: unknown, channelId: string, client: unknown) => {
    const teamId = await slackContextId(body);
    if (!teamId || !channelId) return;
    const connector = await db.getConnector("slack", teamId);
    if (!connector || !connectorSupports(connector, "ingest")) return;
    await syncSlackChannelAccess({
      teamId,
      channelId,
      connector,
      client: client as SlackClientLike,
      force: true,
    });
  };

  app.event("member_joined_channel", async ({ event, body, client }) => {
    await refreshChannelAccess(body, event.channel, client);
  });

  app.event("member_left_channel", async ({ event, body, client }) => {
    await refreshChannelAccess(body, event.channel, client);
  });

  // Proposal-shaped top-level messages get a collision check against rejected decisions.
  app.message(async ({ message, body, client }) => {
    const teamId = await slackContextId(body);
    await ingestSlackMessageEvent(teamId, message, client as unknown as SlackClientLike).catch((error) => {
      console.error("Slack message indexing failed:", (error as Error).message);
    });
    const m = message as { subtype?: string; text?: string; ts?: string; user?: string; channel?: string };
    if (m.subtype || !m.text || !m.user || !m.channel || !looksLikeProposal(m.text)) return;
    const actor = await slackActor(body, m.user, client as unknown as SlackClientLike);
    if (!actor || !canPotentially(actor.access.membership.role, "search.use", actor.access.grants)) return;
    const tenant = await tenantForTeam(actor.teamId);
    if (!tenant || !await legacyMemoryAllowed(tenant, actor.access, "search.use")) return;
    const j = await prim.warn(tenant, m.text).catch((error) => {
      console.error("Slack proposal check failed:", safeJobError(error));
      return null;
    });
    if (j?.matches && j.comment) {
      await client.chat.postEphemeral({ channel: m.channel, user: m.user, thread_ts: m.ts, text: `⚠️ ${j.comment}` });
    }
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.SLACK_PORT ?? 3001);
  try {
    await buildApp().start(port);
    console.log(`orin-slack listening on :${port}`);
    void refreshAllSlackWorkspaceAccess();
    const refreshTimer = setInterval(() => void refreshAllSlackWorkspaceAccess(), 15 * 60_000);
    refreshTimer.unref();
  } catch (e) {
    console.error(`orin-slack: ${(e as Error).message}`);
    process.exit(2);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("slack.js") || entry.endsWith("slack.ts")) void main();
