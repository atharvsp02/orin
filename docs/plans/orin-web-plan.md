# Orin web — dashboard + landing (Milestone B)

One domain: `https://orin-bot.duckdns.org`. Caddy routes API paths (`/v1/*`, `/mcp`, `/slack*`,
`/linear*`, `/api/github/webhooks`) to their services as today; everything else (`/`) goes to the
new `orin-web` Next.js app (pm2, :3003). Self-hosted on rey3 (not Vercel) so session cookies and
API calls are same-origin — no CORS, no cross-site cookie pain.

## Auth (no passwords)
- "Sign in with GitHub" using the GitHub App's OAuth credentials (Client ID `Iv23lixbyRLe985BhXbP`
  + a client secret the user generates). Callback: `https://orin-bot.duckdns.org/v1/auth/callback`.
- Flow (all in the bot server, `bot/src/auth.ts`): `/v1/auth/github` → GitHub authorize →
  `/v1/auth/callback` → exchange code → user token → `GET /user/installations` (which Orin
  installations this user can access) → session = signed httpOnly cookie (HMAC via ORIN_SECRET,
  7-day expiry) holding `{login, avatar, installationIds}`. The user token is discarded after
  login — we never store it. Logout `/v1/auth/logout` clears the cookie.
- Authorization rule: every `/v1/dash/*` endpoint checks the requested installation id is in the
  session's `installationIds`. GitHub is the single source of truth for who administers what.

## Backend endpoints to add (bot server, session-cookie auth)
- `GET  /v1/me` — session user + installations (id, account, decision counts)
- `GET  /v1/dash/:inst/overview` — metrics + recent deliveries (catches feed)
- `GET  /v1/dash/:inst/decisions` — decision records (repo/outcome filters)
- `GET  /v1/dash/:inst/graph` — visualize HTML for that installation (session-auth variant)
- `GET/POST/DELETE /v1/dash/:inst/keys` — list/mint/revoke repo-scoped `orin_` keys
  (list shows label + created_at + revoked; plaintext shown once on mint). Replaces ADMIN_TOKEN.
- `GET/PUT /v1/dash/:inst/settings` — tenant_config (delivery mode, blocking, thresholds,
  custom instructions, llm provider)
- `GET /v1/dash/:inst/integrations` — slack/linear link status; `POST …/link-code` mints a code
  the GitHub side owns (reverse of /orin link: web mints for a chosen installation, Slack admin
  runs `/orin claim <code>`— v2; v1 shows status only)
- db additions: `preflight_keys.label` + `created_at` surfaced; `revokePreflightKey(hash)`;
  `recentDeliveries(inst, limit)`; session helpers need nothing new.

## Web app (Next.js 15 App Router, Tailwind, static-friendly)
- `/` landing: hero, how-it-works (remember→catch→learn loop), surface cards (GitHub/Slack/
  Linear/MCP) with real install links, security section, footer. No auth.
- `/dashboard` (client-side fetch of `/v1/me`; redirect to sign-in if 401):
  - installation switcher
  - Overview: stat tiles (decisions, active rejections, PRs prevented) + recent catches
  - Decisions: filterable table, source links, superseded badges
  - Graph: iframe of `/v1/dash/:inst/graph`
  - Keys: mint (repo-scoped) / revoke
  - Settings: form over GET/PUT settings
- Deploy: `next build` (standalone) → pm2 `orin-web` :3003 → Caddy default route.

## Order
1. Backend: auth.ts + dash endpoints + db helpers (testable without the web).
2. Landing page (public value even before dashboard).
3. Dashboard pages wired to the endpoints.
4. Deploy to rey3 + Caddy default route → orin-web; verify end-to-end with real GitHub login.
