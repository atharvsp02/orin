// Orin Linear adapter — multi-workspace OAuth. Any Linear org installs via /linear/install →
// OAuth consent → per-org token stored encrypted → its own isolated brain auto-provisioned.
// Webhooks (app-level) fire for every installed org; each event resolves that org's own client.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { LinearClient } from "@linear/sdk";
import * as db from "./db.js";
import { resolveTenant, provisionAndLink } from "./tenant.js";
import type { Tenant } from "./tenant.js";
import * as prim from "./primitives.js";

// Narrow facade over the SDK methods we use (the generated types are unwieldy; runtime-verified).
interface Linear {
  createAgentActivity(input: { agentSessionId: string; content: Record<string, unknown> }): Promise<unknown>;
  createComment(input: { issueId: string; body: string }): Promise<unknown>;
  organization: Promise<{ id: string; name: string }>;
}

interface AgentSession {
  id: string;
  issue?: { id?: string; title?: string; description?: string };
  comment?: { body?: string };
}
interface AgentSessionWebhook {
  type: "AgentSessionEvent";
  action: "created" | "prompted";
  agentSession: AgentSession;
  organizationId?: string;
  agentActivity?: { content?: { body?: string } };
}
interface IssueWebhook {
  type: "Issue";
  action: "create" | "update" | "remove";
  data: { id: string; title?: string; description?: string };
  organizationId?: string;
}
type Webhook = AgentSessionWebhook | IssueWebhook | { type: string };

interface LinearInstall {
  accessToken: string;
  orgName?: string;
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Linear adapter needs ${name}`);
  return v;
}

const clientFor = (token: string): Linear => new LinearClient({ accessToken: token }) as unknown as Linear;

/** Per-org Linear client: OAuth install token first, single-workspace env token as dev fallback. */
async function clientForOrg(orgId?: string): Promise<Linear | null> {
  if (orgId) {
    const install = (await db.fetchLinearInstall(orgId)) as LinearInstall | null;
    if (install?.accessToken) return clientFor(install.accessToken);
  }
  return process.env.LINEAR_ACCESS_TOKEN ? clientFor(process.env.LINEAR_ACCESS_TOKEN) : null;
}

// Self-serve: an unknown Linear org gets its own isolated brain on first contact.
const linearTenant = async (orgId?: string): Promise<Tenant | null> => {
  if (!orgId) return null;
  const existing = await resolveTenant({ platform: "linear", externalId: orgId });
  if (existing) return existing;
  return provisionAndLink({ platform: "linear", externalId: orgId }, `linear:${orgId}`).catch((e) => {
    console.error("linear auto-provision failed:", (e as Error).message);
    return null;
  });
};

async function handleSession(client: Linear, wh: AgentSessionWebhook): Promise<void> {
  const sessionId = wh.agentSession.id;
  const tenant = await linearTenant(wh.organizationId);
  const thought = (body: string) => client.createAgentActivity({ agentSessionId: sessionId, content: { type: "thought", body } });
  const respond = (body: string) => client.createAgentActivity({ agentSessionId: sessionId, content: { type: "response", body } });

  if (!tenant) {
    await respond("Orin couldn't provision memory for this Linear workspace — try again shortly.");
    return;
  }
  await thought("Searching past decisions in memory…").catch(() => undefined);

  const s = wh.agentSession;
  const text = [s.issue?.title, s.issue?.description, s.comment?.body, wh.agentActivity?.content?.body]
    .filter(Boolean)
    .join("\n\n");
  const [answer, j] = await Promise.all([prim.ask(tenant, text), prim.warn(tenant, text)]);
  const body =
    j.matches && j.comment
      ? `⚠️ ${j.comment}${answer ? `\n\n${answer}` : ""}`
      : answer || "No relevant past decision found in memory.";
  await respond(body);
}

async function handleIssueCreate(client: Linear, wh: IssueWebhook): Promise<void> {
  const tenant = await linearTenant(wh.organizationId);
  if (!tenant) return;
  const j = await prim.warn(tenant, `${wh.data.title ?? ""}\n\n${wh.data.description ?? ""}`);
  if (j.matches && j.comment) await client.createComment({ issueId: wh.data.id, body: `⚠️ ${j.comment}` });
}

function verify(secret: string, raw: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- OAuth install flow (multi-workspace) ---

const REDIRECT_URI = process.env.LINEAR_REDIRECT_URI ?? "https://orin-bot.duckdns.org/linear/oauth";

// Stateless CSRF state: signed timestamp, valid 15 min.
function mintState(secret: string): string {
  const ts = String(Date.now());
  return `${ts}.${createHmac("sha256", secret).update(ts).digest("hex")}`;
}
function checkState(secret: string, state: string): boolean {
  const [ts, mac] = state.split(".");
  if (!ts || !mac) return false;
  const expected = createHmac("sha256", secret).update(ts).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Date.now() - Number(ts) < 15 * 60_000;
}

// Escape untrusted values before interpolating into HTML (org names are attacker-chosen).
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:36rem;margin:4rem auto">${body}</body>`);
}

function handleInstall(res: ServerResponse, secret: string): void {
  const clientId = process.env.LINEAR_CLIENT_ID;
  if (!clientId) return html(res, 404, "<h2>Orin</h2><p>Linear OAuth is not configured on this server.</p>");
  const u = new URL("https://linear.app/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  const actor = process.env.LINEAR_ACTOR ?? "app"; // act as the app (agent), not the installing user
  // Agent sessions (@mention / assign) require the agent scopes at authorize time.
  const defaultScopes = actor === "app" ? "read,write,app:mentionable,app:assignable" : "read,write";
  u.searchParams.set("scope", process.env.LINEAR_SCOPES ?? defaultScopes);
  u.searchParams.set("actor", actor);
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", mintState(secret));
  res.writeHead(302, { Location: u.toString() }).end();
}

async function handleOAuthCallback(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
  const url = new URL(req.url ?? "/", "https://localhost");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !checkState(secret, state)) return html(res, 400, "<h2>Orin</h2><p>Invalid or expired install link — start again from /linear/install.</p>");

  const tokenRes = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: reqEnv("LINEAR_CLIENT_ID"),
      client_secret: reqEnv("LINEAR_CLIENT_SECRET"),
    }),
  });
  if (!tokenRes.ok) {
    console.error("linear oauth exchange failed:", tokenRes.status, await tokenRes.text());
    return html(res, 502, "<h2>Orin</h2><p>Token exchange with Linear failed — try installing again.</p>");
  }
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) return html(res, 502, "<h2>Orin</h2><p>Linear returned no access token.</p>");

  // Identify the org this token belongs to, store encrypted, and give it its own brain.
  const org = await clientFor(access_token).organization;
  await db.storeLinearInstall(org.id, { accessToken: access_token, orgName: org.name } satisfies LinearInstall);
  await provisionAndLink({ platform: "linear", externalId: org.id }, `linear:${org.name}`).catch((e) =>
    console.error("linear auto-provision failed:", (e as Error).message),
  );
  html(res, 200, `<h2>✅ Orin installed for ${esc(org.name)}</h2><p>Your workspace has its own isolated decision memory. Create an issue (or @mention Orin) to try it.</p>`);
}

// --- HTTP server ---

async function main(): Promise<void> {
  const secret = reqEnv("LINEAR_WEBHOOK_SECRET");
  const port = Number(process.env.LINEAR_PORT ?? 3002);

  createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\/linear(?=\/|$)/, "") || "/"; // tolerate the /linear proxy prefix
    if (req.method === "GET" && path === "/install") return handleInstall(res, secret);
    if (req.method === "GET" && path === "/oauth") {
      void handleOAuthCallback(req, res, secret).catch((e) => {
        console.error("linear oauth error:", (e as Error).message);
        html(res, 500, "<h2>Orin</h2><p>Install failed — check server logs.</p>");
      });
      return;
    }
    if (req.method !== "POST" || path !== "/") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let len = 0;
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      len += c.length;
      if (len > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      // HMAC over the exact received bytes — decoding chunk-by-chunk would corrupt multibyte UTF-8.
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!verify(secret, raw, req.headers["linear-signature"] as string ?? "")) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad signature" }));
        return;
      }
      // Ack within Linear's window, then process out of band.
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      let wh: Webhook;
      try {
        wh = JSON.parse(raw) as Webhook;
      } catch {
        return;
      }
      void (async () => {
        try {
          const orgId = (wh as { organizationId?: string }).organizationId;
          const client = await clientForOrg(orgId);
          if (!client) {
            console.warn("linear: no install token for org", orgId, "— skipping event");
            return;
          }
          if (wh.type === "AgentSessionEvent") {
            const e = wh as AgentSessionWebhook;
            if (e.action === "created" || e.action === "prompted") await handleSession(client, e);
          } else if (wh.type === "Issue" && (wh as IssueWebhook).action === "create") {
            await handleIssueCreate(client, wh as IssueWebhook);
          }
        } catch (err) {
          console.error("linear: processing failed:", (err as Error).message);
        }
      })();
    });
  }).listen(port, () => console.log(`orin-linear listening on :${port}`));
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("linear.js") || entry.endsWith("linear.ts")) {
  main().catch((e) => {
    console.error(`orin-linear: ${(e as Error).message}`);
    process.exit(2);
  });
}
