import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canPotentially, type WorkspacePermission } from "./access.js";
import { send } from "./auth.js";
import * as content from "./content-db.js";
import * as enterprise from "./enterprise-db.js";
import * as llm from "./llm.js";
import { safeJobError } from "./queues.js";

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

function queryHash(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase()).digest("hex");
}

function providerFilter(value: unknown): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return null;
  const provider = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(provider) ? provider : null;
}

async function audit(input: {
  workspaceId: string;
  userId: string;
  action: string;
  outcome?: "success" | "denied" | "failure";
  details: Record<string, unknown>;
}): Promise<void> {
  await enterprise.recordAuditEvent({
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    action: input.action,
    targetType: "knowledge",
    targetId: input.action,
    outcome: input.outcome,
    requestId: randomUUID(),
    details: input.details,
  });
}

async function rateLimit(
  res: ServerResponse,
  workspaceId: string,
  userId: string,
  action: "search" | "chat",
): Promise<boolean> {
  const result = await enterprise.consumeRateLimit({
    workspaceId,
    userId,
    action,
    limit: action === "chat" ? 20 : 60,
  });
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  if (result.allowed) return true;
  res.setHeader("Retry-After", String(result.retryAfterSeconds));
  await audit({ workspaceId, userId, action: `${action}.rate_limited`, outcome: "denied", details: {} });
  send(res, 429, { error: "too many requests", retryAfterSeconds: result.retryAfterSeconds });
  return false;
}

export async function handleWorkspaceKnowledge(input: {
  req: IncomingMessage;
  res: ServerResponse;
  workspaceId: string;
  userId: string;
  resource: string;
  sub?: string;
}): Promise<boolean> {
  const { req, res, workspaceId, userId, resource, sub } = input;
  if (resource !== "search" && resource !== "chat") return false;
  const permission: WorkspacePermission = resource === "search" ? "search.use" : "chat.use";
  const access = await enterprise.getWorkspaceAccess(userId, workspaceId);
  if (!access || !canPotentially(access.membership.role, permission, access.grants)) {
    await audit({ workspaceId, userId, action: "authorization.denied", outcome: "denied", details: { permission } });
    send(res, 403, { error: `no access to ${resource}` });
    return true;
  }

  if (resource === "search" && req.method === "POST" && !sub) {
    const body = await jsonBody(req);
    if (!body || typeof body.query !== "string") {
      send(res, 400, { error: "query is required" });
      return true;
    }
    const query = body.query.replace(/\s+/g, " ").trim();
    if (!query || query.length > 500) {
      send(res, 400, { error: query ? "query is too long" : "query is required" });
      return true;
    }
    if (body.resourceId !== undefined && (typeof body.resourceId !== "string" || !UUID_PATTERN.test(body.resourceId))) {
      send(res, 400, { error: "invalid resource id" });
      return true;
    }
    const provider = providerFilter(body.provider);
    if (provider === null) {
      send(res, 400, { error: "invalid provider" });
      return true;
    }
    if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 50)) {
      send(res, 400, { error: "limit must be an integer from 1 to 50" });
      return true;
    }
    if (!await rateLimit(res, workspaceId, userId, "search")) return true;
    try {
      const results = await content.authorizedSearch({
        workspaceId,
        userId,
        permission: "search.use",
        query,
        provider,
        resourceId: typeof body.resourceId === "string" ? body.resourceId : undefined,
        limit: typeof body.limit === "number" ? body.limit : undefined,
      });
      await audit({
        workspaceId,
        userId,
        action: "search.executed",
        details: { queryHash: queryHash(query), resultItemIds: results.map((result) => result.itemId) },
      });
      send(res, 200, { results });
    } catch (error) {
      console.error("permission-aware search failed:", safeJobError(error));
      await audit({
        workspaceId,
        userId,
        action: "search.failed",
        outcome: "failure",
        details: { queryHash: queryHash(query), error: safeJobError(error) },
      });
      send(res, 500, { error: "permission-aware search failed" });
    }
    return true;
  }

  if (resource === "chat" && req.method === "GET" && !sub) {
    send(res, 200, { threads: await content.listChatThreads(workspaceId, userId) });
    return true;
  }

  if (resource === "chat" && req.method === "GET" && sub) {
    if (!UUID_PATTERN.test(sub)) {
      send(res, 400, { error: "invalid thread id" });
      return true;
    }
    const messages = await content.listAuthorizedChatMessages(workspaceId, userId, sub, "chat.use");
    if (messages.length === 0 && !(await content.listChatThreads(workspaceId, userId)).some((thread) => thread.threadId === sub)) {
      send(res, 404, { error: "thread not found" });
      return true;
    }
    send(res, 200, { threadId: sub, messages });
    return true;
  }

  if (resource === "chat" && req.method === "POST" && !sub) {
    const body = await jsonBody(req);
    if (!body || typeof body.question !== "string") {
      send(res, 400, { error: "question is required" });
      return true;
    }
    const question = body.question.replace(/\s+/g, " ").trim();
    if (!question || question.length > 500) {
      send(res, 400, { error: question ? "question is too long" : "question is required" });
      return true;
    }
    if (body.threadId !== undefined && (typeof body.threadId !== "string" || !UUID_PATTERN.test(body.threadId))) {
      send(res, 400, { error: "invalid thread id" });
      return true;
    }
    if (body.resourceId !== undefined && (typeof body.resourceId !== "string" || !UUID_PATTERN.test(body.resourceId))) {
      send(res, 400, { error: "invalid resource id" });
      return true;
    }
    const provider = providerFilter(body.provider);
    if (provider === null) {
      send(res, 400, { error: "invalid provider" });
      return true;
    }
    const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    if (threadId && !(await content.listChatThreads(workspaceId, userId)).some((thread) => thread.threadId === threadId)) {
      send(res, 404, { error: "thread not found" });
      return true;
    }
    if (!await rateLimit(res, workspaceId, userId, "chat")) return true;
    try {
      let results = await content.authorizedSearch({
        workspaceId,
        userId,
        permission: "chat.use",
        query: question,
        provider,
        resourceId: typeof body.resourceId === "string" && UUID_PATTERN.test(body.resourceId) ? body.resourceId : undefined,
        limit: 8,
      });
      let answer = await llm.answerQuestion(question, results.map((result) => ({
        title: result.title,
        snippet: result.snippet,
        provider: result.provider,
        url: result.url,
      })));
      const currentResults = await content.getAuthorizedItemsByIds({
        workspaceId,
        userId,
        itemIds: results.map((result) => result.itemId),
        permission: "chat.use",
      });
      if (currentResults.length !== results.length) {
        results = [];
        answer = "Your source access changed while I was answering. Please ask again.";
      }
      const exchange = await content.createChatExchange({
        workspaceId,
        userId,
        threadId,
        question,
        answer,
        citationItemIds: results.map((result) => result.itemId),
      });
      await audit({
        workspaceId,
        userId,
        action: "chat.answered",
        details: {
          queryHash: queryHash(question),
          threadId: exchange.threadId,
          citationItemIds: results.map((result) => result.itemId),
        },
      });
      send(res, 200, { threadId: exchange.threadId, answer, citations: results });
    } catch (error) {
      await audit({
        workspaceId,
        userId,
        action: "chat.failed",
        outcome: "failure",
        details: { queryHash: queryHash(question), error: safeJobError(error) },
      });
      send(res, 502, { error: "permission-aware answer generation failed" });
    }
    return true;
  }

  send(res, 405, { error: "unsupported method or resource" });
  return true;
}
