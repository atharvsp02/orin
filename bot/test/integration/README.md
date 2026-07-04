# Integration tests

These exercise the persistence + Cognee-client layers against **real** infrastructure, so they're
kept out of `npm test` (which is pure/hermetic). Run them when a live Postgres is available.

- **`db.mjs`** — every DB function against a real Postgres: crypto roundtrip, repo-scoping &
  cross-repo isolation, supersession, deliveries + IDOR guards, preflight keys, feedback drain,
  tenant links, encrypted Slack installs, metrics, and cascade teardown.
- **`cognee.mjs`** — the real `cognee.ts` REST client + the feedback lifecycle against an in-process
  **mock** Cognee server (verifies request casing/multipart fields + response parsing) and real
  Postgres. No LLM required.

## Run

```bash
# bring up a throwaway Postgres (any will do); then:
npm run build
DATABASE_URL="postgres://user@127.0.0.1:5432/codeguard" npm run test:integration
```

`cognee.mjs` starts its own mock server on `127.0.0.1:8899` and sets `COGNEE_BASE_URL` itself.

The LLM-judgment paths (`evaluatePr` final judge, `ingestItem`/`seedRules` extraction) are **not**
covered here — they need live LLM keys. Their pure inputs are unit-tested in `test/pipeline.test.mjs`.
