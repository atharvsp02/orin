# Orin — live deployment reference

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
| — | Cognee engine (internal) | 8000 | `orin-cognee` |

Each adapter runs from a wrapper script (`~/codeguard/start-*.sh`) under pm2 (`pm2 save`d).
Secrets live only in `~/codeguard/bot/.env` (chmod 600, git-ignored) and never in this repo.

## GitHub App
- App ID `4220734`, public (`github.com/apps/orinbot`). Webhook URL `…/api/github/webhooks`.
- Private key: `~/codeguard/bot/github-app.pem` on the VM (loaded via `GITHUB_PRIVATE_KEY_PATH`).
- Permissions: Pull requests R/W, Issues R/W, Checks R/W, Contents R, Metadata R.
- Events: Pull request, Issues, Issue comment (installation events are automatic).

## MCP adapter
- Config for Cursor / Claude Desktop / any MCP client: [`mcp-client-config.example.json`](mcp-client-config.example.json)
  (a ready-to-use copy with a real demo key is in the git-ignored `mcp-client-config.local.json`).
- Tools: `ask_decision`, `check_rejected`, `record_decision`. Auth: a repo-scoped `orin_` bearer key.

## Slack adapter
- Paste [`slack-app-manifest.json`](slack-app-manifest.json) at **api.slack.com/apps → App Manifest (JSON)** → Save.
- Install via `https://orin-bot.duckdns.org/slack/install`.
- App ID `A0BF7VA9TJN`. Secrets (signing/client/state) are in the VM `.env`.
- **Self-serve:** every new workspace is auto-provisioned its own isolated memory on install.
- **Commands:** `/why [repo:owner/name] <question>` · `/orin link|status|repos|unlink|help` ·
  react `:decision:` on a message to record it.

## Linking a Slack workspace to a GitHub org's memory (cross-platform)
1. In Slack: `/orin link` → Orin replies (ephemeral) with a one-time code (15 min, single-use,
   bound to that workspace).
2. On GitHub: someone with **write access** comments `@orin link <CODE>` on any issue/PR in the
   org → Orin links the workspace to that installation's memory.
Security: minting is ephemeral + workspace-bound; consuming is write-access-gated; a used/leaked
code grants nothing. `/orin unlink` reverts the workspace to a fresh memory of its own.

## Linear adapter (pending credentials)
- Needs a Linear OAuth token/API key + webhook signing secret. Then: env + `start-linear.sh` +
  Caddy `/linear` route. Webhook URL `https://orin-bot.duckdns.org/linear`.
- **Self-serve:** an unknown Linear org is auto-provisioned its own memory on first event.

## Add a new adapter route (Caddy)
`/etc/caddy/Caddyfile` on rey3 — add a `handle /x* { reverse_proxy localhost:PORT }` block inside the
`orin-bot.duckdns.org { … }` site, keeping the final `handle { reverse_proxy localhost:3000 }` catch-all.
`sudo caddy validate` → `sudo systemctl reload caddy`. Never touch the `moros-market.duckdns.org` block.
