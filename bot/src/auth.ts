// Dashboard sign-in: GitHub OAuth (the App's own OAuth credentials), no passwords.
// GitHub is the source of truth for authorization: after login we ask which installations of
// THIS App the user can access, and that list (in a signed cookie) is all they can see.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import * as db from "./db.js";

const COOKIE = "orin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const key = () => createHash("sha256").update(`${config.secret}:session`).digest();

export interface Session {
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
  res.writeHead(status, { "Content-Type": "application/json" });
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

// Origin that served the request: Vercel/Caddy set x-forwarded-host/proto. Falls back to WEB_ORIGIN.
export function requestOrigin(req: IncomingMessage): string {
  const first = (v: unknown): string => String(v ?? "").split(",")[0].trim();
  // Prefer the ORIGINAL host as forwarded by the front proxy (Next dev / Vercel rewrite), which
  // Caddy is configured to pass through; fall back to the direct Host header, then WEB_ORIGIN.
  const host = first(req.headers["x-forwarded-host"]) || first(req.headers.host);
  if (!host) return config.webOrigin;
  const proto = first(req.headers["x-forwarded-proto"]) || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
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
  res.writeHead(302, { Location: u.toString() }).end();
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
    login?: string;
    avatar_url?: string;
  };
  const insts = (await (await fetch("https://api.github.com/user/installations?per_page=100", { headers: gh })).json()) as {
    installations?: Array<{ id: number; app_id: number }>;
  };
  // The user token is used ONLY here and discarded; the session carries just the outcome.
  const ids = (insts.installations ?? [])
    .filter((i) => String(i.app_id) === String(config.github.appId))
    .map((i) => i.id);

  if (!user.login) return send(res, 502, { error: "github user lookup failed" });
  const session: Session = { login: user.login, avatar: user.avatar_url ?? "", ids, exp: Date.now() + SESSION_TTL_MS };
  res.setHeader("Set-Cookie", [
    `${COOKIE}=${encodeSession(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    `${NONCE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
  res.writeHead(302, { Location: "/dashboard" }).end(); // relative: works on any serving origin
}

/** GET/POST /v1/auth/logout — clear the session. */
export function handleLogout(res: ServerResponse): void {
  setCookie(res, "", 0);
  res.writeHead(302, { Location: "/" }).end();
}

/** GET /v1/me — who am I + which installations I can see (enriched from our DB). */
export async function handleMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const s = sessionFrom(req);
  if (!s) return send(res, 401, { error: "not signed in" });
  const installations = [];
  for (const id of s.ids) {
    const inst = await db.getInstallation(id);
    if (inst) {
      installations.push({
        installationId: id,
        account: inst.githubAccount,
        decisions: await db.countDecisions(id),
      });
    }
  }
  send(res, 200, { login: s.login, avatar: s.avatar, installations });
}
