# Orin - live deployment reference

Everything runs on the **rey3** Azure VM (`ssh rey3`, key `~/.ssh/rey3_key.pem`), behind Caddy on
`orin-bot.duckdns.org` (own duckdns subdomain, TLS auto, kept pointed at the IP by a cron so it
survives restarts). The `moros-*` services on the same box are untouched (their own Caddy block +
port 8787). Shared core for every adapter: **Postgres + Cognee 1.2.2 (DeepSeek + local fastembed)**.

## Public endpoints (all under `https://orin-bot.duckdns.org`)

| Path | Serves | Port | pm2 |
| --- | --- | --- | --- |
| `/api/github/webhooks` | GitHub App webhooks | 3000 | `orin-bot` |
| `/v1/preflight`, `/v1/metrics`, `/v1/graph`, `/v1/preflight-keys` | CI pre-flight + dashboard APIs | 3000 | `orin-bot` |
| `/mcp` | MCP server (IDE agents / CI) | 8788 | `orin-mcp` |
| `/slack/*` | Slack app (events, commands, OAuth) | 3001 | `orin-slack` |
| `/linear` | Linear adapter (planned) | 3002 | `orin-linear` |
| `/v1/connectors/google-drive/*` | Google Drive OAuth | 3000 | `orin-bot` |
| `/v1/workspaces/*` | Workspace search, chat, admin, connector, and audit APIs | 3000 | `orin-bot` |
| - | Cognee engine (internal) | 8000 | `orin-cognee` |

Each adapter runs from a wrapper script (`~/codeguard/start-*.sh`) under pm2 (`pm2 save`d).
Secrets live only in `~/codeguard/bot/.env` (chmod 600, git-ignored) and never in this repo.

## GitHub App
- App ID `4220734`, public (`github.com/apps/orinbot`). Webhook URL `…/api/github/webhooks`.
- Private key: `~/codeguard/bot/github-app.pem` on the VM (loaded via `GITHUB_PRIVATE_KEY_PATH`).
- Permissions: Pull requests R/W, Issues R/W, Checks R/W, Contents R, Metadata R, Organization members R, and Email addresses R.
- Events: Pull request, Issues, Issue comment (installation events are automatic).
- Organization members R is required to prove organization ownership before workspace bootstrap. Email addresses R is required to merge a verified GitHub identity with an invited workspace member.

## MCP adapter
- Config for Cursor / Claude Desktop / any MCP client: [`mcp-client-config.example.json`](mcp-client-config.example.json)
  (a ready-to-use copy with a real demo key is in the git-ignored `mcp-client-config.local.json`).
- Tools: `ask_decision`, `check_rejected`, `record_decision`. Auth: a repo-scoped `orin_` bearer key.

## Slack adapter
- Paste [`slack-app-manifest.json`](slack-app-manifest.json) at **api.slack.com/apps → App Manifest (JSON)** → Save.
- Install via `https://orin-bot.duckdns.org/slack/install`.
- App ID `A0BF7VA9TJN`. Secrets (signing/client/state) are in the VM `.env`.
- **Self-serve:** every new workspace is auto-provisioned its own isolated memory on install. If Slack reports the installer as a current workspace administrator or owner and returns an email address, that installer becomes the first Orin owner. A reinstall can recover an ownerless Slack-only workspace, but never grants membership in a linked or shared workspace.
- **Commands:** `/why [repo:owner/name] <question>` · `/orin link|status|repos|unlink|help` ·
  react `:brain:` on a message to record it.
- **Permission-aware search:** subscribe to `message.channels`, `message.groups`, `member_joined_channel`, and `member_left_channel`. Grant `channels:read`, `channels:history`, `groups:read`, `groups:history`, `users:read`, and `users:read.email`. Reinstall the app after changing scopes.
- Orin indexes new and edited messages only in channels where the app is present. Deleted messages are removed. Channel ACL synchronization fails closed.
- The Slack process refreshes indexed channel membership every 15 minutes. Search hides Slack content when its channel ACL is more than 30 minutes old.
- `/why`, `@Orin`, status, and repository listing require an active Orin workspace member linked by Slack email. Ask responses are private. Brain-reaction recording requires content administration permission.

## Linking a Slack workspace to a GitHub org's memory (cross-platform)
1. In Slack: `/orin link` → Orin replies (ephemeral) with a one-time code (15 min, single-use,
   bound to that workspace).
2. On GitHub: the personal installation owner or an active organization owner comments `@orin link <CODE>` on an issue or PR in the target installation.
Security: minting is ephemeral + workspace-bound; consuming requires proven installation ownership; a used/leaked
code grants nothing. `/orin unlink` reverts the workspace to a fresh memory of its own.

## Linear adapter (multi-workspace OAuth; pending credentials)
- Create a Linear OAuth application (Settings → API → Applications): callback
  `https://orin-bot.duckdns.org/linear/oauth`, webhook `https://orin-bot.duckdns.org/linear`
  (events: Issues + Agent session events), enable the agent option if offered.
- Env needed: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`
  (optional `LINEAR_ACCESS_TOKEN` as single-workspace dev fallback; `LINEAR_ACTOR=app` default).
- **Self-serve:** any org installs at `https://orin-bot.duckdns.org/linear/install` → OAuth consent →
  per-org token stored encrypted → its own isolated memory auto-provisioned.

## Google Drive connector

- Configure `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` in the bot environment.
- Register `https://orin-seven.vercel.app/v1/connectors/google-drive/callback` as an authorized redirect URI.
- Use a Web application OAuth client and enable the Google Drive API.
- Orin requests read-only Drive access plus basic OpenID profile scopes.
- Credentials are encrypted with `ORIN_SECRET`. Disconnect removes credentials and disables the connector.
- The connector scheduler queues active Drive connectors every 15 minutes. Manual sync is available in the dashboard.
- A failed sync marks restricted ACLs stale and sets the connector to error, so search and chat fail closed.

## Deployment order

1. Back up Postgres and verify restore access.
2. Deploy the bot first. Startup applies additive schema changes before serving requests.
3. Confirm queue startup, `/v1/me`, and one workspace overview.
4. Review existing workspace owners and admins once. Older deployments may contain memberships created before ownership proof was enforced.
5. Deploy the web app with `ORIN_API_ORIGIN` pointing at the bot.
6. Run a Drive sync in a non-production workspace and verify ACL-filtered search with owner and viewer accounts.
7. Reinstall Slack in a non-production workspace, send a channel message, and verify that a channel member can search it while a non-member cannot.
8. Check connector sync and authorization events in the audit log.

Rollback the application to the previous bot and web builds if verification fails. The schema additions are backward compatible and should remain in place during application rollback. Do not drop new tables during an incident.

## Verification commands

```bash
npm --prefix bot test
DATABASE_URL=postgres://... npm --prefix bot run test:integration
npm --prefix web run lint
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web exec -- playwright install chromium
npm --prefix web run test:e2e
```

Next is intentionally pinned at `16.0.10`. The current npm audit reports advisories that require a newer Next release. Treat the framework upgrade as a separate reviewed change before exposing a self-hosted web process directly to untrusted traffic.

## Add a new adapter route (Caddy)
`/etc/caddy/Caddyfile` on rey3 - add a `handle /x* { reverse_proxy localhost:PORT }` block inside the
`orin-bot.duckdns.org { … }` site, keeping the final `handle { reverse_proxy localhost:3000 }` catch-all.
`sudo caddy validate` → `sudo systemctl reload caddy`. Never touch the `moros-market.duckdns.org` block.
