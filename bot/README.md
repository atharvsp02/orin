# CodeGuard bot

Multi-tenant GitHub App backend. Ingests a repo's closed issues/PRs into a per-installation
Cognee knowledge graph, catches PRs/issues that re-propose already-rejected decisions, and
answers `@codeguard` questions with citations.

## HTTP endpoints

- `POST /` — GitHub webhooks (handled by Octokit middleware).
- `POST /v1/preflight` — contributor pre-flight check (below).
- `POST /v1/preflight-keys` — mint a preflight key (admin-only; disabled unless `ADMIN_TOKEN` is set).

## Contributor pre-flight (A5)

Lets a contributor check a change against the repo's recorded decisions **before** opening a PR —
no GitHub writes, no feedback session, just the read-side catch pipeline.

Mint a repo-scoped key (once, out-of-band until the dashboard owns this):

```bash
curl -X POST "$BOT_URL/v1/preflight-keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"installationId": 12345, "repo": "owner/name"}'
# -> { "key": "cg_…", "repo": "owner/name", "installationId": 12345 }
```

Only the SHA-256 hash of the key is stored; the plaintext is shown once.

### CLI

```bash
CODEGUARD_TOKEN=cg_… CODEGUARD_URL=$BOT_URL/v1/preflight  node bot/cli/codeguard.mjs main
```

Exits `1` when the change re-proposes a rejected decision and blocking is enabled, `0` otherwise.

### GitHub Action

```yaml
- uses: ./bot/action
  with:
    token: ${{ secrets.CODEGUARD_TOKEN }}
    endpoint: https://your-bot/v1/preflight
```

Fails the check when `blocking` is true, surfacing the decision id via `::error::`.

Response shape:

```json
{ "matches": true, "blocking": true, "decisionId": "PR-42", "comment": "…" }
```
