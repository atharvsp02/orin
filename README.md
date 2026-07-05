# Orin

Institutional-memory GitHub App for open-source maintainers. It ingests a repo's issues, PRs, and maintainer decisions into a self-hosted Cognee knowledge graph, answers onboarding questions with citations, and comments on new PRs that re-propose something already tried and rejected.

> **Self-hosted Cognee OSS, own LLM/vector/graph config — not using Cogwit.** (Cognee "Hangover Part AI" hackathon — Open Source track.)

## Structure (separated by concern)

- `bot/`    — GitHub App backend: webhook listener + async workers (Node + TypeScript, npm).
- `web/`    — Next.js dashboard, deploys to Vercel (Milestone B).
- `engine/` — self-hosted `cognee/cognee` Docker Compose + env template.
- `docs/`   — build plan (`docs/plans`) and verification specs (`docs/specs`).
- `inspiration/` — cloned reference repos for study (git-ignored).

Each component is its own project — e.g. `cd bot && npm install`.

## Getting started

1. **engine** — `cd engine`, `cp .env.example .env` (use a **paid LLM tier** for ingestion), then `docker compose up -d`.
2. **bot** — `cd bot`, `npm install`, `cp .env.example .env`, `npm run dev`.
3. **web** — scaffolded at Milestone B.

See `docs/plans/orin-plan.md` for the full build plan and `docs/specs/` for the verified specs.
