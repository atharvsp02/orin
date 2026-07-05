# Orin bot

Multi-tenant GitHub App backend. Ingests a repo's closed issues/PRs into a per-installation
Cognee knowledge graph, catches PRs/issues that re-propose already-rejected decisions, and
answers `@orin` questions with citations.

## Entrypoints

One package, several `npm run` targets (they share the decision core in `src/pipeline.ts`):

| script | process |
| --- | --- |
| `start` | GitHub App webhook server + async workers |
| `mcp` / `mcp:http` | MCP server (stdio / streamable HTTP) for IDE agents + CI |
| `slack` | Slack app (Bolt) |
| `linear` | Linear agent adapter |

## HTTP endpoints (webhook server)

- `POST /` — GitHub webhooks (handled by Octokit middleware).
- `POST /v1/preflight` — contributor pre-flight check (below), preflight-key auth.
- `POST /v1/preflight-keys` — mint a preflight key (admin-only; disabled unless `ADMIN_TOKEN` is set).
- `GET /v1/metrics` — `{prsPrevented, decisionsTracked, rejectionsActive}` for a repo, preflight-key auth.
- `GET /v1/graph` — interactive knowledge-graph HTML (CSP-sandboxed), preflight-key auth.

## Cognee lifecycle (all four verbs fire live)

`remember` (ingest on install + on PR/issue close) → `recall` (session-scoped `GRAPH_COMPLETION_COT`
during catch) → `improve` (hourly worker applies maintainer feedback) → `forget` (on uninstall or
`@orin forget`). Feedback comes from `@orin good|bad` (or 👍/👎) on a flagged thread.

## `@orin` commands

`recall <q>`, `why`, `override [REF] "reason"`, `ignore`, `re-scan`, `good`/`bad` (feedback),
`forget` (admin), `rules` (list), `rule <text>` (seed a coding rule).

## Adapters (share one decision core)

- **MCP** (`npm run mcp`): tools `ask_decision`→ask, `check_rejected`→warn, `record_decision`→ingest.
  Auth via a repo-scoped `orin_` key in `ORIN_TOKEN`; the server always calls Cognee with the
  tenant's own key, never the client's token. `bot/cli/orin-mcp.mjs` is a CI gate over stdio.
- **Slack** (`npm run slack`): `/why`, react `:decision:` to ingest, proposal-shaped messages get a
  collision-warn. Multi-workspace OAuth; install tokens encrypted at rest.
- **Linear** (`npm run linear`): `AgentSessionEvent` → `thought` then cited `response`; issue-create
  collision-warn via comment. HMAC-verified webhook.

Non-GitHub adapters resolve their tenant via `tenant_links` (a Slack team / Linear workspace linked
to a GitHub installation) — there is **no** silent default-tenant fallback, so an unlinked workspace
can never read or poison another tenant's memory.

## Contributor pre-flight (A5)

Lets a contributor check a change against the repo's recorded decisions **before** opening a PR —
no GitHub writes, no feedback session, just the read-side catch pipeline.

Mint a repo-scoped key (once, out-of-band until the dashboard owns this):

```bash
curl -X POST "$BOT_URL/v1/preflight-keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"installationId": 12345, "repo": "owner/name"}'
# -> { "key": "orin_…", "repo": "owner/name", "installationId": 12345 }
```

Only the SHA-256 hash of the key is stored; the plaintext is shown once.

### CLI

```bash
ORIN_TOKEN=orin_… ORIN_URL=$BOT_URL/v1/preflight  node bot/cli/orin.mjs main
```

Exits `1` when the change re-proposes a rejected decision and blocking is enabled, `0` otherwise.

### GitHub Action

```yaml
- uses: ./bot/action
  with:
    token: ${{ secrets.ORIN_TOKEN }}
    endpoint: https://your-bot/v1/preflight
```

Fails the check when `blocking` is true, surfacing the decision id via `::error::`.

Response shape:

```json
{ "matches": true, "blocking": true, "decisionId": "PR-42", "comment": "…" }
```
