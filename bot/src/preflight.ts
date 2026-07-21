import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { config } from "./config.js";
import { evaluatePr } from "./pipeline.js";
import type { TenantCredentials } from "./cognee.js";
import { safeJobError } from "./queues.js";

const cog = { baseUrl: config.cogneeBaseUrl };

interface PreflightRequest {
  title?: string;
  description?: string;
  diff?: string;
}

interface IssueKeyRequest {
  installationId?: number;
  repo?: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const constantEq = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const bearer = (req: IncomingMessage): string => {
  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
};

/** Resolve a repo-scoped `orin_…` bearer key to its installation + repo (or null). */
async function authKey(req: IncomingMessage): Promise<{ installationId: number; repo: string } | null> {
  const key = bearer(req);
  if (!key) return null;
  return db.lookupPreflightKey(sha256(key));
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      len += c.length;
      if (len > limit) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); // concat then decode once (multibyte-safe)
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Contributor pre-flight: POST /v1/preflight with a repo-scoped `orin_…` bearer key.
 * Runs the catch pipeline against the repo's decisions with NO GitHub writes.
 */
export async function handlePreflight(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mapping = await authKey(req);
  if (!mapping) return send(res, 401, { error: "missing/invalid bearer key" });

  let body: PreflightRequest;
  try {
    body = JSON.parse(await readBody(req)) as PreflightRequest;
  } catch {
    return send(res, 400, { error: "invalid json body" });
  }

  const inst = await db.getInstallation(mapping.installationId);
  if (!inst) return send(res, 404, { error: "unknown installation" });
  const cfg = await db.getTenantConfig(mapping.installationId);
  const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
  const prText = `${body.title ?? ""}\n\n${body.description ?? ""}\n\n${body.diff ?? ""}`.slice(0, 20_000);

  // No sessionId (no feedback QA) and no GitHub writes — pure read-side check.
  const judgment = await evaluatePr(inst, cfg, creds, prText, mapping.repo);
  send(res, 200, {
    matches: judgment.matches,
    blocking: cfg.blockOnRepropose && judgment.matches,
    decisionId: judgment.decisionId,
    comment: judgment.comment,
  });
}

/**
 * Mint a repo-scoped `orin_…` preflight key. Guarded by ADMIN_TOKEN until the
 * dashboard owns issuance. The plaintext key is returned once; only its hash is stored.
 */
export async function handleIssueKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config.adminToken) return send(res, 404, { error: "issuance disabled" });
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!constantEq(token, config.adminToken)) return send(res, 401, { error: "unauthorized" });

  let body: IssueKeyRequest;
  try {
    body = JSON.parse(await readBody(req)) as IssueKeyRequest;
  } catch {
    return send(res, 400, { error: "invalid json body" });
  }
  const installationId = Number(body.installationId);
  const repo = (body.repo ?? "").trim();
  if (!installationId || !repo) return send(res, 400, { error: "installationId and repo required" });
  if (!(await db.getInstallation(installationId))) return send(res, 404, { error: "unknown installation" });

  const key = `orin_${randomBytes(24).toString("hex")}`;
  await db.insertPreflightKey(sha256(key), installationId, repo);
  send(res, 201, { key, repo, installationId });
}

/** Read-side metrics for a repo (the "PRs prevented" panel). Preflight-key auth. */
export async function handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mapping = await authKey(req);
  if (!mapping) return send(res, 401, { error: "missing/invalid bearer key" });
  const m = await db.metrics(mapping.installationId, mapping.repo);
  send(res, 200, { repo: mapping.repo, ...m });
}

/** Interactive knowledge-graph HTML for the tenant's decision memory. Preflight-key auth. */
export async function handleGraph(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mapping = await authKey(req);
  if (!mapping) return send(res, 401, { error: "missing/invalid bearer key" });
  const inst = await db.getInstallation(mapping.installationId);
  if (!inst) return send(res, 404, { error: "unknown installation" });
  const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
  try {
    const datasetId = await cognee.getDatasetId(cog, creds, inst.datasetName);
    if (!datasetId) return send(res, 404, { error: "no dataset yet" });
    const html = await cognee.visualize(cog, creds, datasetId);
    // The graph HTML embeds labels derived from repo content (issue/PR text), so it is UNTRUSTED.
    // `sandbox allow-scripts` (no allow-same-origin) runs the graph's own JS in an opaque origin:
    // it can't read app-origin cookies/DOM or call /v1/*, neutralizing stored-XSS escalation.
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts; default-src 'self' 'unsafe-inline' data:; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(html);
  } catch (error) {
    console.error("preflight graph unavailable:", safeJobError(error));
    send(res, 502, { error: "graph unavailable" });
  }
}
