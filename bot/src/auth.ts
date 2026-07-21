// Dashboard sign-in: GitHub OAuth (the App's own OAuth credentials), no passwords.
// GitHub is the source of truth for authorization: after login we ask which installations of
// THIS App the user can access, and that list (in a signed cookie) is all they can see.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { can, WORKSPACE_PERMISSIONS } from "./access.js";
import { config } from "./config.js";
import * as db from "./db.js";
import * as enterprise from "./enterprise-db.js";

const COOKIE = "orin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const key = () => createHash("sha256").update(`${config.secret}:session`).digest();

export interface Session {
  userId?: string;
  login: string;
  avatar: string;
  ids: number[]; // installation ids this user administers
  exp: number;
}

const b64u = (b: Buffer) => b.toString("base64url");
const sign = (payload: string) => b64u(createHmac("sha256", key()).update(payload).digest());

function encodeSession(s: Session): string {
  const payload = b64u(Buffer.from(JSON.stringify(s)));
  return `${payload}.${sign(payload)}`;
}

export function sessionFrom(req: IncomingMessage): Session | null {
  const cookie = req.headers.cookie ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, mac] = m[1].split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (!s.exp || Date.now() > s.exp) return null;
    return s;
  } catch {
    return null;
  }
}

function setCookie(res: ServerResponse, value: string, maxAgeSec: number): void {
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  // Authenticated, per-user responses must NEVER be cached by a CDN/proxy (Vercel edge, etc.),
  // or one user's data (e.g. /v1/me installations) leaks to the next visitor. no-store is mandatory.
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Cookie",
  });
  res.end(JSON.stringify(body));
}

// CSRF state bound to THIS browser: a nonce lives in a short-lived cookie AND inside the signed
// state. The callback only accepts a state whose nonce matches the cookie, so an attacker cannot
// log a victim into the attacker's account by handing them a foreign callback URL (login CSRF).
const NONCE_COOKIE = "orin_oauth";
const mintState = (nonce: string) => {
  const ts = String(Date.now());
  return `${ts}.${nonce}.${sign(`${ts}.${nonce}`)}`;
};
const checkState = (req: IncomingMessage, state: string): boolean => {
  const [ts, nonce, mac] = state.split(".");
  if (!ts || !nonce || !mac) return false;
  const a = Buffer.from(sign(`${ts}.${nonce}`));
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  if (Date.now() - Number(ts) >= 15 * 60_000) return false;
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${NONCE_COOKIE}=([^;]+)`));
  const cookieNonce = m?.[1] ?? "";
  const cn = Buffer.from(cookieNonce);
  const n = Buffer.from(nonce);
  return cn.length === n.length && cn.length > 0 && timingSafeEqual(cn, n);
};

// Origin that served the request, used to build the OAuth redirect_uri and callback.
export function requestOrigin(req: IncomingMessage): string {
  // A configured WEB_ORIGIN is authoritative. Vercel rewrites do NOT forward x-forwarded-host and
  // rewrite Host to our own backend domain, so the request headers here point at the bot, not the
  // user-facing origin. Only fall back to headers in local dev, where WEB_ORIGIN is unset.
  if (process.env.WEB_ORIGIN) return process.env.WEB_ORIGIN.replace(/\/+$/, "");
  const first = (v: unknown): string => String(v ?? "").split(",")[0].trim();
  const host = first(req.headers["x-forwarded-host"]) || first(req.headers.host);
  if (!host) return config.webOrigin;
  const proto = first(req.headers["x-forwarded-proto"]) || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export function originsMatch(origin: string, expected: string): boolean {
  try {
    return new URL(origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

export function hasTrustedMutationOrigin(req: IncomingMessage): boolean {
  const method = req.method ?? "GET";
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  const origin = String(req.headers.origin ?? "");
  return Boolean(origin) && originsMatch(origin, requestOrigin(req));
}

const oauthConfigured = () => Boolean(config.oauth.clientId && config.oauth.clientSecret);

/** GET /v1/auth/github — start the sign-in flow. */
export function handleAuthStart(req: IncomingMessage, res: ServerResponse): void {
  if (!oauthConfigured()) return send(res, 404, { error: "sign-in not configured" });
  const nonce = randomBytes(16).toString("base64url");
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", config.oauth.clientId as string);
  u.searchParams.set("redirect_uri", `${requestOrigin(req)}/v1/auth/callback`);
  u.searchParams.set("state", mintState(nonce));
  res.setHeader("Set-Cookie", `${NONCE_COOKIE}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`);
  res.writeHead(302, { Location: u.toString(), "Cache-Control": "private, no-store, max-age=0" }).end();
}

/** GET /v1/auth/callback?code&state — exchange, identify, authorize, set session. */
export async function handleAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!oauthConfigured()) return send(res, 404, { error: "sign-in not configured" });
  const url = new URL(req.url ?? "/", "https://localhost");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !checkState(req, state)) return send(res, 400, { error: "invalid or expired sign-in link" });

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: config.oauth.clientId as string,
      client_secret: config.oauth.clientSecret as string,
      code,
      redirect_uri: `${requestOrigin(req)}/v1/auth/callback`,
    }),
  });
  const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!token) return send(res, 502, { error: "github token exchange failed" });

  const gh = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "orin-bot" };
  const user = (await (await fetch("https://api.github.com/user", { headers: gh })).json()) as {
    id?: number;
    login?: string;
    name?: string;
    email?: string;
    avatar_url?: string;
  };
  const insts = (await (await fetch("https://api.github.com/user/installations?per_page=100", { headers: gh })).json()) as {
    installations?: Array<{ id: number; app_id: number }>;
  };
  // The user token is used ONLY here and discarded; the session carries just the outcome.
  const ids = (insts.installations ?? [])
    .filter((i) => String(i.app_id) === String(config.github.appId))
    .map((i) => i.id);

  if (!user.login || !user.id) return send(res, 502, { error: "github user lookup failed" });
  const orinUser = await enterprise.upsertUserIdentity({
    provider: "github",
    externalId: String(user.id),
    handle: user.login,
    displayName: user.name?.trim() || user.login,
    email: user.email,
    avatarUrl: user.avatar_url,
  });
  await enterprise.addUserIdentity(orinUser.userId, {
    provider: "github_login",
    externalId: user.login.toLowerCase(),
    handle: user.login,
    email: user.email,
  });
  await bootstrapSessionMemberships(ids, orinUser.userId);
  const session: Session = {
    userId: orinUser.userId,
    login: user.login,
    avatar: user.avatar_url ?? "",
    ids,
    exp: Date.now() + SESSION_TTL_MS,
  };
  res.setHeader("Set-Cookie", [
    `${COOKIE}=${encodeSession(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    `${NONCE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
  // no-store so a CDN never caches this Set-Cookie response and hands one user's session to another.
  res.writeHead(302, { Location: "/dashboard", "Cache-Control": "private, no-store, max-age=0" }).end();
}

/** GET/POST /v1/auth/logout — clear the session. */
export function handleLogout(res: ServerResponse): void {
  setCookie(res, "", 0);
  res.writeHead(302, { Location: "/", "Cache-Control": "private, no-store, max-age=0" }).end();
}

async function bootstrapSessionMemberships(ids: number[], userId: string): Promise<void> {
  for (const installationId of ids) {
    const workspace = await db.getWorkspaceByInstallation(installationId);
    if (workspace) await enterprise.bootstrapWorkspaceMembership(userId, workspace.workspaceId);
  }
}

export async function authenticatedUser(req: IncomingMessage): Promise<{
  session: Session;
  user: enterprise.OrinUser;
} | null> {
  const session = sessionFrom(req);
  if (!session) return null;
  let user = session.userId ? await enterprise.getUser(session.userId) : null;
  user ??= await enterprise.getUserByIdentity("github_login", session.login.toLowerCase());
  user ??= await enterprise.upsertUserIdentity({
    provider: "github_login",
    externalId: session.login.toLowerCase(),
    handle: session.login,
    displayName: session.login,
    avatarUrl: session.avatar,
  });
  await bootstrapSessionMemberships(session.ids, user.userId);
  return { session, user };
}

/** GET /v1/me — who am I + which installations I can see (enriched from our DB). */
export async function handleMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticatedUser(req);
  if (!auth) return send(res, 401, { error: "not signed in" });
  const { session: s, user } = auth;
  const installations = [];
  for (const id of s.ids) {
    const inst = await db.getInstallation(id);
    if (inst) {
      const decisions = await db.countDecisions(id);
      installations.push({
        installationId: id,
        account: inst.githubAccount,
        decisions,
      });
    }
  }
  const workspaces = await Promise.all((await enterprise.listUserWorkspaces(user.userId)).map(async (workspace) => {
    const connectors = await db.listConnectors(workspace.workspaceId);
    const access = await enterprise.getWorkspaceAccess(user.userId, workspace.workspaceId);
    return {
      workspaceId: workspace.workspaceId,
      displayName: workspace.displayName,
      decisions: workspace.decisions,
      role: workspace.role,
      permissions: access
        ? WORKSPACE_PERMISSIONS.filter((permission) => can(access.membership.role, permission, access.grants))
        : [],
      connectors: connectors.map(({ provider, displayName, status, capabilities }) => ({
        provider,
        displayName,
        status,
        capabilities,
      })),
    };
  }));
  send(res, 200, {
    userId: user.userId,
    login: s.login,
    displayName: user.displayName,
    email: user.primaryEmail,
    avatar: user.avatarUrl || s.avatar,
    workspaces,
    installations,
  });
}
