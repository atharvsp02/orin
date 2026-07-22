import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { can, canPotentially, WORKSPACE_PERMISSIONS } from "./access.js";
import { config } from "./config.js";
import * as db from "./db.js";
import * as enterprise from "./enterprise-db.js";

const COOKIE = "orin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const key = () => createHash("sha256").update(`${config.secret}:session`).digest();
const slackJwks = createRemoteJWKSet(new URL("https://slack.com/openid/connect/keys"), {
  [customFetch]: (...args) => fetch(...args),
});

export type AuthProvider = "github" | "slack" | "linear";

export interface Session {
  userId?: string;
  provider?: AuthProvider;
  login: string;
  avatar: string;
  ids: number[];
  exp: number;
}

interface GitHubUser {
  id?: number;
  login?: string;
  name?: string;
  email?: string;
  avatar_url?: string;
}

interface GitHubInstallation {
  id: number;
  app_id: number;
  target_type?: string;
  account?: { id?: number; login?: string; type?: string };
}

interface GitHubOrganizationMembership {
  state?: string;
  role?: string;
}

export interface SlackOpenIdIdentity {
  teamId: string;
  userId: string;
  name: string;
  email: string;
  picture: string;
}

export interface LinearViewerIdentity {
  organizationId: string;
  organizationName: string;
  userId: string;
  name: string;
  email: string;
  avatarUrl: string;
  admin: boolean;
  owner: boolean;
}

export async function fetchGitHubInstallations(
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubInstallation[] | null> {
  const installations: GitHubInstallation[] = [];
  const seen = new Set<string>();
  let url = "https://api.github.com/user/installations?per_page=100";
  while (url && !seen.has(url) && seen.size < 100) {
    seen.add(url);
    const response = await fetchImpl(url, { headers });
    if (!response.ok) return null;
    const page = await response.json() as { installations?: GitHubInstallation[] };
    if (page.installations !== undefined && !Array.isArray(page.installations)) return null;
    installations.push(...(page.installations ?? []));
    const next = response.headers.get("link")?.split(",").find((part) => part.includes('rel="next"'))?.match(/<([^>]+)>/)?.[1] ?? "";
    if (next) {
      try {
        const parsed = new URL(next);
        if (parsed.origin !== "https://api.github.com" || parsed.pathname !== "/user/installations") return null;
        url = parsed.toString();
      } catch {
        return null;
      }
    } else url = "";
  }
  return url ? null : installations;
}

export function githubInstallationBootstrapEligible(
  installation: GitHubInstallation,
  user: GitHubUser,
  membership?: GitHubOrganizationMembership,
): boolean {
  const targetType = installation.target_type ?? installation.account?.type;
  if (targetType === "User") return installation.account?.id === user.id;
  return targetType === "Organization" && membership?.state === "active" && membership.role === "admin";
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
    if (!s.exp || Date.now() > s.exp || !Array.isArray(s.ids) || typeof s.login !== "string" || typeof s.avatar !== "string") return null;
    if (s.provider && !["github", "slack", "linear"].includes(s.provider)) return null;
    return s;
  } catch {
    return null;
  }
}

function cookieHeader(
  req: IncomingMessage,
  name: string,
  value: string,
  maxAgeSec: number,
): string {
  const secure = requestOrigin(req).startsWith("https://") ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAgeSec: number): void {
  res.setHeader("Set-Cookie", cookieHeader(req, COOKIE, value, maxAgeSec));
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
const nonceCookie = (provider: AuthProvider) => `orin_oauth_${provider}`;

export const mintOAuthState = (provider: AuthProvider, nonce: string, now = Date.now()) => {
  const ts = String(now);
  return `${ts}.${provider}.${nonce}.${sign(`${ts}.${provider}.${nonce}`)}`;
};

export const checkOAuthState = (
  req: IncomingMessage,
  state: string,
  provider: AuthProvider,
  now = Date.now(),
): boolean => {
  const [ts, stateProvider, nonce, mac] = state.split(".");
  if (!ts || stateProvider !== provider || !nonce || !mac) return false;
  const a = Buffer.from(sign(`${ts}.${provider}.${nonce}`));
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const issuedAt = Number(ts);
  if (!Number.isFinite(issuedAt) || issuedAt > now || now - issuedAt >= 15 * 60_000) return false;
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${nonceCookie(provider)}=([^;]+)`));
  const cookieNonce = m?.[1] ?? "";
  const cn = Buffer.from(cookieNonce);
  const n = Buffer.from(nonce);
  return cn.length === n.length && cn.length > 0 && timingSafeEqual(cn, n);
};

function oauthStateNonce(state: string): string {
  return state.split(".")[2] ?? "";
}

function linearCodeVerifier(nonce: string): string {
  return sign(`linear-pkce.${nonce}`);
}

function linearCodeChallenge(nonce: string): string {
  return b64u(createHash("sha256").update(linearCodeVerifier(nonce)).digest());
}

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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSlackOpenIdIdentity(value: unknown): SlackOpenIdIdentity | null {
  const profile = recordValue(value);
  if (!profile || profile.ok !== true || profile.email_verified !== true) return null;
  const teamId = stringValue(profile["https://slack.com/team_id"]);
  const userId = stringValue(profile["https://slack.com/user_id"]);
  const email = stringValue(profile.email).toLowerCase();
  const name = stringValue(profile.name) || stringValue(profile.preferred_username) || email.split("@")[0];
  if (!teamId || !userId || !email.includes("@")) return null;
  return { teamId, userId, email, name, picture: stringValue(profile.picture) };
}

export function normalizeLinearViewerIdentity(value: unknown): LinearViewerIdentity | null {
  const response = recordValue(value);
  const data = recordValue(response?.data);
  const viewer = recordValue(data?.viewer);
  const organization = recordValue(viewer?.organization);
  const organizationId = stringValue(organization?.id);
  const userId = stringValue(viewer?.id);
  const email = stringValue(viewer?.email).toLowerCase();
  const name = stringValue(viewer?.name) || stringValue(viewer?.displayName) || email.split("@")[0];
  if (!organizationId || !userId || !email.includes("@") || viewer?.active !== true || viewer?.app === true) return null;
  return {
    organizationId,
    organizationName: stringValue(organization?.name) || organizationId,
    userId,
    name,
    email,
    avatarUrl: stringValue(viewer?.avatarUrl),
    admin: viewer?.admin === true,
    owner: viewer?.owner === true,
  };
}

export function slackAdminEligible(value: unknown, userId: string, email: string): boolean {
  const response = recordValue(value);
  const user = recordValue(response?.user);
  const profile = recordValue(user?.profile);
  return response?.ok === true && stringValue(user?.id) === userId && user?.deleted !== true && user?.is_bot !== true &&
    (user?.is_admin === true || user?.is_owner === true || user?.is_primary_owner === true) &&
    stringValue(profile?.email).toLowerCase() === email.toLowerCase();
}

async function slackIdTokenIsValid(token: string, nonce: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, slackJwks, {
      issuer: "https://slack.com",
      audience: config.slackAuth.clientId,
    });
    return typeof payload.nonce === "string" && payload.nonce === nonce;
  } catch {
    return false;
  }
}

function beginOAuth(req: IncomingMessage, res: ServerResponse, provider: AuthProvider): { nonce: string; state: string } {
  const nonce = randomBytes(16).toString("base64url");
  res.setHeader("Set-Cookie", cookieHeader(req, nonceCookie(provider), nonce, 900));
  return { nonce, state: mintOAuthState(provider, nonce) };
}

function finishSignIn(
  req: IncomingMessage,
  res: ServerResponse,
  input: { provider: AuthProvider; user: enterprise.OrinUser; login: string; avatar: string; ids?: number[] },
): void {
  const session: Session = {
    userId: input.user.userId,
    provider: input.provider,
    login: input.login,
    avatar: input.avatar,
    ids: input.ids ?? [],
    exp: Date.now() + SESSION_TTL_MS,
  };
  res.setHeader("Set-Cookie", [
    cookieHeader(req, COOKIE, encodeSession(session), SESSION_TTL_MS / 1000),
    cookieHeader(req, nonceCookie(input.provider), "", 0),
  ]);
  res.writeHead(302, { Location: "/dashboard", "Cache-Control": "private, no-store, max-age=0" }).end();
}

async function providerOwnedWorkspaceId(provider: "slack" | "linear", externalId: string): Promise<string | null> {
  const connector = await db.getConnector(provider, externalId);
  if (!connector || connector.status !== "active") return null;
  const workspace = await db.getWorkspace(connector.workspaceId);
  if (workspace?.legacyInstallationId === undefined) return null;
  const installation = await db.getInstallation(workspace.legacyInstallationId);
  return installation?.githubAccount.toLowerCase().startsWith(`${provider}:`) ? workspace.workspaceId : null;
}

const githubOauthConfigured = () => Boolean(config.oauth.clientId && config.oauth.clientSecret);
const slackOauthConfigured = () => Boolean(config.slackAuth.clientId && config.slackAuth.clientSecret);
const linearOauthConfigured = () => Boolean(config.linearAuth.clientId && config.linearAuth.clientSecret);

export function handleAuthProviders(res: ServerResponse): void {
  send(res, 200, {
    providers: {
      github: githubOauthConfigured(),
      slack: slackOauthConfigured(),
      linear: linearOauthConfigured(),
    },
  });
}

export function handleAuthStart(req: IncomingMessage, res: ServerResponse): void {
  if (!githubOauthConfigured()) return send(res, 404, { error: "sign-in not configured" });
  const { state } = beginOAuth(req, res, "github");
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", config.oauth.clientId as string);
  u.searchParams.set("redirect_uri", `${requestOrigin(req)}/v1/auth/callback`);
  u.searchParams.set("state", state);
  res.writeHead(302, { Location: u.toString(), "Cache-Control": "private, no-store, max-age=0" }).end();
}

export async function handleAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!githubOauthConfigured()) return send(res, 404, { error: "sign-in not configured" });
  const url = new URL(req.url ?? "/", "https://localhost");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !checkOAuthState(req, state, "github")) return send(res, 400, { error: "invalid or expired sign-in link" });

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
  const token = tokenRes.ok ? ((await tokenRes.json()) as { access_token?: string }).access_token : undefined;
  if (!token) return send(res, 502, { error: "github token exchange failed" });

  const gh = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "orin-bot",
  };
  const [userResponse, installationRows, emailsResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers: gh }),
    fetchGitHubInstallations(gh),
    fetch("https://api.github.com/user/emails?per_page=100", { headers: gh }),
  ]);
  if (!userResponse.ok || !installationRows) return send(res, 502, { error: "github account lookup failed" });
  const user = await userResponse.json() as GitHubUser;
  const emails = emailsResponse.ok
    ? await emailsResponse.json() as Array<{ email?: string; primary?: boolean; verified?: boolean }>
    : [];

  if (!user.login || !user.id) return send(res, 502, { error: "github user lookup failed" });
  const verifiedEmail = emails.find((email) => email.primary && email.verified)?.email;
  const installations = installationRows.filter(
    (installation) => String(installation.app_id) === String(config.github.appId),
  );
  const eligibleInstallations: GitHubInstallation[] = [];
  for (let offset = 0; offset < installations.length; offset += 10) {
    const batch = installations.slice(offset, offset + 10);
    const eligible = await Promise.all(batch.map(async (installation) => {
      let membership: GitHubOrganizationMembership | undefined;
      const targetType = installation.target_type ?? installation.account?.type;
      if (targetType === "Organization" && installation.account?.login) {
        try {
          const response = await fetch(
            `https://api.github.com/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`,
            { headers: gh },
          );
          if (response.ok) membership = await response.json() as GitHubOrganizationMembership;
        } catch {
          membership = undefined;
        }
      }
      return githubInstallationBootstrapEligible(installation, user, membership) ? installation : null;
    }));
    eligibleInstallations.push(...eligible.filter((installation): installation is GitHubInstallation => installation !== null));
  }
  const ids = eligibleInstallations.map((installation) => installation.id);
  const orinUser = await enterprise.upsertUserIdentity({
    provider: "github",
    externalId: String(user.id),
    handle: user.login,
    displayName: user.name?.trim() || user.login,
    email: verifiedEmail,
    avatarUrl: user.avatar_url,
    reactivate: false,
  });
  if (orinUser.status !== "active") return send(res, 403, { error: "account is inactive" });
  await enterprise.addUserIdentity(orinUser.userId, {
    provider: "github_login",
    externalId: user.login.toLowerCase(),
    handle: user.login,
    email: verifiedEmail,
  });
  await bootstrapSessionMemberships(ids, orinUser.userId);
  finishSignIn(req, res, {
    provider: "github",
    user: orinUser,
    login: user.login,
    avatar: user.avatar_url ?? "",
    ids,
  });
}

export function handleSlackAuthStart(req: IncomingMessage, res: ServerResponse): void {
  if (!slackOauthConfigured()) return send(res, 404, { error: "Slack sign-in is not configured" });
  const { nonce, state } = beginOAuth(req, res, "slack");
  const redirectUri = `${requestOrigin(req)}/v1/auth/slack/callback`;
  const authorize = new URL("https://slack.com/openid/connect/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("client_id", config.slackAuth.clientId as string);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  res.writeHead(302, { Location: authorize.toString(), "Cache-Control": "private, no-store, max-age=0" }).end();
}

async function slackIdentityIsAdmin(identity: SlackOpenIdIdentity): Promise<boolean> {
  const installation = recordValue(await db.fetchSlackInstall(identity.teamId));
  const bot = recordValue(installation?.bot);
  const token = stringValue(bot?.token);
  if (!token) return false;
  try {
    const url = new URL("https://slack.com/api/users.info");
    url.searchParams.set("user", identity.userId);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    return response.ok && slackAdminEligible(await response.json(), identity.userId, identity.email);
  } catch {
    return false;
  }
}

export async function handleSlackAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!slackOauthConfigured()) return send(res, 404, { error: "Slack sign-in is not configured" });
  const url = new URL(req.url ?? "/", "https://localhost");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !checkOAuthState(req, state, "slack")) return send(res, 400, { error: "invalid or expired sign-in link" });
  const redirectUri = `${requestOrigin(req)}/v1/auth/slack/callback`;
  const tokenResponse = await fetch("https://slack.com/api/openid.connect.token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.slackAuth.clientId as string,
      client_secret: config.slackAuth.clientSecret as string,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokenBody = tokenResponse.ok ? recordValue(await tokenResponse.json()) : null;
  const accessToken = stringValue(tokenBody?.access_token);
  const idToken = stringValue(tokenBody?.id_token);
  if (!accessToken || !idToken || tokenBody?.ok !== true) return send(res, 502, { error: "Slack token exchange failed" });
  if (!await slackIdTokenIsValid(idToken, oauthStateNonce(state))) {
    return send(res, 403, { error: "Slack identity token validation failed" });
  }
  const profileResponse = await fetch("https://slack.com/api/openid.connect.userInfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const identity = profileResponse.ok ? normalizeSlackOpenIdIdentity(await profileResponse.json()) : null;
  if (!identity) return send(res, 403, { error: "Slack did not return a verified identity" });
  const user = await enterprise.upsertUserIdentity({
    provider: "slack_user",
    externalId: `${identity.teamId}:${identity.userId}`,
    handle: identity.userId,
    displayName: identity.name,
    email: identity.email,
    avatarUrl: identity.picture,
    reactivate: false,
  });
  if (user.status !== "active") return send(res, 403, { error: "account is inactive" });
  const workspaceId = await providerOwnedWorkspaceId("slack", identity.teamId);
  if (workspaceId && await slackIdentityIsAdmin(identity)) {
    const membership = await enterprise.claimUnownedWorkspace(user.userId, workspaceId);
    if (membership) {
      await enterprise.recordAuditEvent({
        workspaceId,
        actorUserId: user.userId,
        action: "membership.claimed",
        targetType: "user",
        targetId: user.userId,
        details: { provider: "slack", role: membership.role },
      });
    }
  }
  finishSignIn(req, res, {
    provider: "slack",
    user,
    login: identity.name,
    avatar: identity.picture,
  });
}

export function handleLinearAuthStart(req: IncomingMessage, res: ServerResponse): void {
  if (!linearOauthConfigured()) return send(res, 404, { error: "Linear sign-in is not configured" });
  const { nonce, state } = beginOAuth(req, res, "linear");
  const authorize = new URL("https://linear.app/oauth/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", config.linearAuth.clientId as string);
  authorize.searchParams.set("redirect_uri", `${requestOrigin(req)}/v1/auth/linear/callback`);
  authorize.searchParams.set("scope", "read");
  authorize.searchParams.set("actor", "user");
  authorize.searchParams.set("prompt", "consent");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", linearCodeChallenge(nonce));
  authorize.searchParams.set("code_challenge_method", "S256");
  res.writeHead(302, { Location: authorize.toString(), "Cache-Control": "private, no-store, max-age=0" }).end();
}

export async function handleLinearAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!linearOauthConfigured()) return send(res, 404, { error: "Linear sign-in is not configured" });
  const url = new URL(req.url ?? "/", "https://localhost");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !checkOAuthState(req, state, "linear")) return send(res, 400, { error: "invalid or expired sign-in link" });
  const redirectUri = `${requestOrigin(req)}/v1/auth/linear/callback`;
  const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.linearAuth.clientId as string,
      client_secret: config.linearAuth.clientSecret as string,
      code_verifier: linearCodeVerifier(oauthStateNonce(state)),
    }),
  });
  const tokenBody = tokenResponse.ok ? recordValue(await tokenResponse.json()) : null;
  const accessToken = stringValue(tokenBody?.access_token);
  if (!accessToken) return send(res, 502, { error: "Linear token exchange failed" });
  const viewerResponse = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: "query OrinDashboardViewer { viewer { id name displayName email avatarUrl active app admin owner organization { id name } } }",
    }),
  });
  const identity = viewerResponse.ok ? normalizeLinearViewerIdentity(await viewerResponse.json()) : null;
  if (!identity) return send(res, 403, { error: "Linear did not return an active user identity" });
  const user = await enterprise.upsertUserIdentity({
    provider: "linear_user",
    externalId: `${identity.organizationId}:${identity.userId}`,
    handle: identity.userId,
    displayName: identity.name,
    email: identity.email,
    avatarUrl: identity.avatarUrl,
    reactivate: false,
  });
  if (user.status !== "active") return send(res, 403, { error: "account is inactive" });
  const workspaceId = await providerOwnedWorkspaceId("linear", identity.organizationId);
  if (workspaceId && (identity.owner || identity.admin)) {
    const membership = await enterprise.claimUnownedWorkspace(user.userId, workspaceId);
    if (membership) {
      await enterprise.recordAuditEvent({
        workspaceId,
        actorUserId: user.userId,
        action: "membership.claimed",
        targetType: "user",
        targetId: user.userId,
        details: { provider: "linear", role: membership.role },
      });
    }
  }
  finishSignIn(req, res, {
    provider: "linear",
    user,
    login: identity.name,
    avatar: identity.avatarUrl,
  });
}

export function handleLogout(req: IncomingMessage, res: ServerResponse): void {
  setCookie(req, res, "", 0);
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
  const provider = session.provider ?? "github";
  if (!user && provider === "github") {
    user = await enterprise.getUserByIdentity("github_login", session.login.toLowerCase());
    user ??= await enterprise.upsertUserIdentity({
      provider: "github_login",
      externalId: session.login.toLowerCase(),
      handle: session.login,
      displayName: session.login,
      avatarUrl: session.avatar,
      reactivate: false,
    });
  }
  if (!user) return null;
  if (user.status !== "active") return null;
  return { session, user };
}

export async function handleMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticatedUser(req);
  if (!auth) return send(res, 401, { error: "not signed in" });
  const { session: s, user } = auth;
  const installations = [];
  for (const id of s.ids) {
    const inst = await db.getInstallation(id);
    const workspace = await db.getWorkspaceByInstallation(id);
    if (inst && workspace && await enterprise.getWorkspaceAccess(user.userId, workspace.workspaceId)) {
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
    const visibleConnectors = [];
    if (access) {
      for (const connector of connectors) {
        const providerVisible = can(
          access.membership.role,
          "connectors.read",
          access.grants,
          { connectorProvider: connector.provider },
        );
        const resourceVisible = !providerVisible && (await db.listConnectorResources(connector.connectorId)).some((resource) => can(
          access.membership.role,
          "connectors.read",
          access.grants,
          { connectorProvider: connector.provider, resourceId: resource.resourceId },
        ));
        if (providerVisible || resourceVisible) visibleConnectors.push(connector);
      }
    }
    return {
      workspaceId: workspace.workspaceId,
      displayName: workspace.displayName,
      decisions: workspace.decisions,
      role: workspace.role,
      hasGitHubCompatibility: workspace.legacyInstallationId !== undefined,
      permissions: access
        ? WORKSPACE_PERMISSIONS.filter((permission) => canPotentially(access.membership.role, permission, access.grants))
        : [],
      connectors: visibleConnectors.map(({ provider, displayName, status, capabilities }) => ({
        provider,
        displayName,
        status,
        capabilities,
      })),
    };
  }));
  send(res, 200, {
    userId: user.userId,
    provider: s.provider ?? "github",
    login: s.login,
    displayName: user.displayName,
    email: user.primaryEmail,
    avatar: user.avatarUrl || s.avatar,
    workspaces,
    installations,
  });
}
