<p align="center">
  <img src="assets/orin-mark-dark.svg#gh-light-mode-only" alt="Orin" width="84" />
  <img src="assets/orin-mark-light.svg#gh-dark-mode-only" alt="Orin" width="84" />
</p>

<h1 align="center">Orin</h1>

<p align="center">
  <b>Institutional memory for engineering teams. Orin remembers every decision your team makes and catches the ones you are about to repeat, everywhere your team works.</b>
</p>

> A team rejects an idea for a good reason. Months later the person who knew the reason has moved on, the same idea comes back in a new PR, and nobody remembers why you said no. Orin is the memory that does. It reads your repo's closed issues and PRs into a self-hosted Cognee knowledge graph, then catches re-proposals on new PRs and issues with a citation to the original decision, and answers "why did we do X?" from GitHub, Slack, Linear, your IDE, and CI.

Orin is **one shared memory reachable from six surfaces**: a **GitHub App**, a **Slack** app, a **Linear** agent, an **MCP** server for your IDE, a **CI** pre-flight, and a **dashboard**. It is not a GitHub bot with some integrations bolted on; every surface reads and writes the same per-tenant knowledge graph.

GitHub is where the memory is formed. Install the App on a repo and it backfills every closed issue and PR, extracts the real decisions (what was proposed, what was decided, and the reasoning), and grounds them in a [Cognee](https://github.com/topoteretes/cognee) knowledge graph using a decision ontology. From then on, that same memory works everywhere your team does: it fails a merge-blocking check on a re-proposing PR with the exact prior decision cited, answers `/why` in Slack with evidence, acts as an `@Orin` agent in Linear, gates a change in Cursor or Claude Code over MCP before a PR even exists, and blocks a CI job before review. One decision, recorded once, enforced on every surface.

The engine is **self-hosted Cognee OSS** (the open-source `cognee/cognee`, not the hosted Cogwit product), running on your own LLM, vector, and graph config, with hard multi-tenant isolation so each install has its own private graph. Built for the Cognee hackathon, Open Source track.

---

## Table of Contents

- [What Orin Does](#what-orin-does)
- [Why It Exists](#why-it-exists)
- [How It Works](#how-it-works)
  - [The Ingest Pipeline](#the-ingest-pipeline)
  - [The Precision Catch](#the-precision-catch)
  - [The GitHub App](#the-github-app)
  - [Slack](#slack)
  - [Linear](#linear)
  - [MCP and CI Pre-flight](#mcp-and-ci-pre-flight)
  - [The Dashboard](#the-dashboard)
- [Built on Cognee](#built-on-cognee)
- [Surfaces](#surfaces)
- [Commands](#commands)
- [Live Instance](#live-instance)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Tech Stack](#tech-stack)
- [Security Model](#security-model)
- [For Judges and Reviewers](#for-judges-and-reviewers)

---

## What Orin Does

Orin is four parts working as one memory:

1. **A GitHub App (`bot/`).** A webhook backend (Node + TypeScript) that provisions an isolated Cognee tenant on install, backfills the repo's history, catches re-proposals on new PRs and issues, and runs the `@orinbot` command set. Heavy work runs on a Postgres-backed queue so webhook acks stay fast.

2. **Three adapters on the same memory.** A **Slack** app (`/why`, a brain reaction to record a decision, `@Orin` mentions), a **Linear** agent (in-issue sessions and collision warnings on issue creation), and an **MCP server** (three tools for Cursor, Claude Code, or any MCP client). Each install is an isolated tenant; Slack and Linear can be linked to a GitHub org's memory with a one-time code.

3. **A self-hosted Cognee engine (`engine/`).** The open-source `cognee/cognee` REST engine with backend access control on, so every tenant's decisions live in a separate, key-scoped graph. Orin drives the full Cognee lifecycle: `remember` (ontology-grounded ingest), `recall` (cited graph completion), `improve` (maintainer feedback reweights the graph), and `forget` (on uninstall).

4. **A dashboard (`web/`).** A Next.js app (landing page plus signed-in dashboard) where you see every catch with its citation, browse recorded decisions, explore the knowledge graph, manage org and repo-scoped rules, upload docs into memory, mint repo-scoped keys, and tune delivery, all read live from the tenant's real data.

Put together: a maintainer rejects an idea and closes the thread the way they always do; a minute later it is a decision in Orin's graph; weeks later someone re-proposes it and Orin catches it before anyone wastes a review, citing the original; and the same decision answers `/why` in Slack and `check_rejected` in an IDE. One decision, recorded once, enforced everywhere.

---

## Why It Exists

Engineering teams lose the same argument twice. A dependency is rejected, an architecture is decided against, a migration is deferred, and the reasoning lives in a closed thread that nobody re-reads. When the same proposal returns (from a new hire, a coding agent, or just forgetfulness) the team re-litigates it from scratch, or worse, merges the thing they already decided not to.

Code review bots today are stateless: they look at the diff in front of them, not at what the team already decided. Orin is the opposite. It is precision-first and memory-first: it stays **silent** unless it can ground a re-proposal in a specific, cited past decision, and when it does speak, it cites the exact issue or PR and its reasoning rather than an opinion.

The design is honest about its own failure mode. A memory system that cries wolf is worse than none, so the catch runs through two independent gates before any LLM judgment (a deterministic term-overlap gate and a semantic-distance gate), and only ever blocks on a decision that was actually **rejected and not since superseded**. Decisions are never deleted, they are superseded, so context can always change: one comment overrides a decision with receipts, and the check clears.

Self-hosting Cognee (rather than a hosted memory API) is deliberate. Decisions are sensitive, multi-tenant isolation has to be real, and the whole point of the hackathon's Open Source track is to run the OSS engine on your own LLM, vector store, and graph. Orin runs `cognee/cognee` with `ENABLE_BACKEND_ACCESS_CONTROL=true`, a per-tenant API key, and a DeepSeek + local-embeddings config, so no decision ever leaves infrastructure the team controls.

---

## How It Works

### The Ingest Pipeline

On `installation.created`, Orin provisions an isolated Cognee tenant (`cognee.provisionTenant` returns a non-expiring `X-Api-Key`, stored encrypted at rest), uploads the decision ontology, and enqueues a backfill job per repo. The ingest worker (`bot/src/worker.ts` -> `pipeline.ts::ingestItem`) fetches closed, signal-rich issues and PRs, and for each thread the LLM (`llm.ts::extractDecision`) pulls out a structured decision: title, outcome (`rejected` / `accepted` / `reverted`), reasoning, key terms, and any decisions it supersedes. Real decisions are `remember`ed into the tenant's Cognee dataset (grounded by the ontology) and mirrored into Postgres for the deterministic gate. After that, every closed PR or issue live-ingests a single decision, so memory compounds forward without a re-scan.

### The Precision Catch

On a new or updated PR (`pull_request.opened/reopened/ready_for_review/synchronize`) or a new issue (`issues.opened`), the catch worker runs `pipeline.ts::evaluatePr`, which is deliberately conservative:

1. **Deterministic gate.** Only decisions that share at least `confidenceThreshold` significant terms with the PR text are even considered (`grounded()`), which kills the bulk of false positives.
2. **Semantic gate.** A Cognee `CHUNKS` search returns per-chunk relevance scores; matches above the `scoreCutoff` distance are dropped, with a small bounded recency penalty so an old-but-exactly-re-proposed decision is still caught.
3. **Cited recall + judgment.** Survivors go through a `GRAPH_COMPLETION_COT` recall (chain-of-thought over the graph, recorded as a session so feedback can reweight it) and an LLM judgment (`judgePr`) that returns a citation and comment, or nothing.

Only a decision that is `rejected` and not superseded can block. Delivery is configurable per install: a merge-blocking **status check**, an inline **review**, or a plain **comment**. Advisory coding-rules that the PR touches are cited alongside the finding but never block on their own. If nothing grounds, Orin says nothing.

### The GitHub App

`bot/src/index.ts` is a single Node HTTP server. It verifies webhooks with the App's own signing key (`app.webhooks.verifyAndReceive`, no OAuth on the webhook path) and fans events onto a `pg-boss` queue (`ingest`, `catch`, `command`, `lifecycle`). `issue_comment.created` routes `@orinbot <cmd>` mentions to the command worker (`commands.ts`), which enforces GitHub permissions per command (write access for mutations, admin for `forget`). On `installation.deleted` it runs the live `forget` verb and tears down the tenant.

### Slack

`bot/src/slack.ts` is a Bolt app. `/why [repo] <question>` returns a cited answer; a brain reaction records the reacted message as a decision; `@Orin` mentions answer in-thread. A workspace gets its own isolated memory on install and can be linked to a GitHub org's memory with `/orin link` (mints a one-time code) then `@orinbot link CODE` on GitHub (consumed by someone with write access).

### Linear

`bot/src/linear.ts` is a multi-workspace OAuth app. It answers `@Orin` agent-session mentions in issues with cited recalls, warns on issue creation when a new issue collides with a past decision, and supports the same `@Orin link` -> `@orinbot link CODE` flow to share a GitHub org's memory.

### MCP and CI Pre-flight

`bot/src/mcp.ts` is a Model Context Protocol server (streamable HTTP) exposing three tools that map to the same grounded primitives: **`why`** (cited recall), **`check_rejected`** (returns `{matches, decisionId, comment}` for a proposed change), and **`record_decision`**. It authenticates with a repo-scoped `orin_…` key, so Cursor, Claude Code, or any MCP client can ask Orin before a PR even exists.

For CI, `bot/action/action.yml` is a composite **GitHub Action** ("Orin Preflight") that diffs the PR, POSTs it to `/v1/preflight` with the repo key, and fails the job with an `::error::` (citing the `decisionId`) when the change re-proposes a rejected decision.

### The Dashboard

`web/` is a Next.js 16 app (React 19, Tailwind 4, Radix, framer-motion) with a Linear-style landing page and a signed-in dashboard. Sign-in is GitHub OAuth against the App's client credentials, held in an HMAC-signed session cookie (the GitHub token is never stored). The dashboard mirrors the product: **Catches** (each with its citation and evidence), **Decisions** (outcome, reasoning, supersession, source), **Repos**, **Rules** (org-wide or per-repo scope), **Docs** (upload ADRs and postmortems straight into memory), a **Knowledge graph** (a self-contained force graph built from the tenant's real decisions and the entities Cognee extracted), **Integrations** (install links and the MCP snippet), **Keys** (mint and revoke repo-scoped keys), and **Settings** (delivery mode, grounding threshold, semantic cutoff). Every number is read live from the tenant's data; empty states are honest and never fabricated. The `/v1/*` API is proxied through Next so cookies stay first-party on any origin, and all authenticated responses are `no-store` so a CDN never serves one user's data to another.

---

## Built on Cognee

Cognee is the memory substrate for the entire product. Orin uses its full lifecycle, live, on a self-hosted OSS deployment:

- **remember** - `POST /api/v1/remember` ingests each decision (and uploaded docs and rules) with `cognify`, grounded by an uploaded OWL **decision ontology** (`bot/src/ontology.ts`) so extraction knows what a "decision", "outcome", and "supersession" are.
- **recall** - the catch and every `why` run `GRAPH_COMPLETION_COT` (chain-of-thought graph completion) through `/api/v1/recall` with a session id, plus `CHUNKS` for scored evidence and `CODING_RULES` for rule retrieval. Time-scoped questions route to `TEMPORAL`.
- **improve** - maintainer `@orinbot good` / `@orinbot bad` feedback attaches a score to the exact recall session, and an hourly `lifecycle` job runs Cognee's `improve` to reweight the graph nodes that produced the verdict.
- **forget** - uninstalling the App prunes the whole tenant graph via Cognee's `forget`.

Isolation is enforced by Cognee's backend access control: each install is a separate tenant with its own `X-Api-Key`, and the bot always calls Cognee key-scoped. The engine runs DeepSeek for extraction and judgment with **local `fastembed` embeddings** (no embedding key needed) over a file-based Kuzu + LanceDB stack. Nothing about a team's decisions leaves the self-hosted engine.

---

## Surfaces

| Surface | How you use it | Backed by |
| ------- | -------------- | --------- |
| **GitHub App** | Required check / review / comment on PRs and issues; `@orinbot` commands | `bot/src/index.ts`, `commands.ts` |
| **Slack** | `/why`, brain reaction to record, `@Orin` mentions | `bot/src/slack.ts` |
| **Linear** | `@Orin` agent in issues, collision warnings on create | `bot/src/linear.ts` |
| **MCP** | `why`, `check_rejected`, `record_decision` in Cursor / Claude Code / CLI | `bot/src/mcp.ts` |
| **CI** | `POST /v1/preflight` via the "Orin Preflight" GitHub Action | `bot/src/preflight.ts`, `bot/action/action.yml` |
| **Dashboard** | Catches, decisions, graph, rules, docs, keys, settings | `web/` |

---

## Commands

Typed on any GitHub issue or PR as `@orinbot <cmd>` (use `@orinbot`, not `@orin`, which is a real GitHub user). Mutations require write access; `forget` requires admin.

| Command | What it does |
| ------- | ------------ |
| `@orinbot why` / `recall <q>` | Cited answer from the repo's decision memory |
| `@orinbot override REF "reason"` | Record a new decision superseding `REF`; Orin stops flagging it |
| `@orinbot rule <text>` / `rules` | Add or list standing rules (scoped to this repo) |
| `@orinbot good` / `bad` | Rate a catch; reweights the graph via Cognee `improve` |
| `@orinbot ignore` / `re-scan` | Mute this thread / re-run the check |
| `@orinbot link CODE` | Link a Slack or Linear workspace to this org's memory |
| `@orinbot forget` | Prune all of Orin's memory for this account (admin only) |

Slack uses the slash commands `/why` and `/orin` (with `link`, `status`, `repos`, `help`).

---

## Live Instance

Orin is deployed and running:

| Thing | Where |
| ----- | ----- |
| GitHub App | [`github.com/apps/orinbot`](https://github.com/apps/orinbot) |
| Dashboard + landing | [`orin-seven.vercel.app`](https://orin-seven.vercel.app) |
| API / webhooks / MCP / Slack / Linear | `https://orin-bot.duckdns.org` (Caddy reverse-proxy on an Azure VM; pm2-managed) |
| Self-hosted Cognee | `cognee/cognee` 1.2.2 on the same VM, bound to localhost |

The demo org **`ydark926/orin-demo`** is a live tenant: Orin backfilled its history into **12 recorded decisions (11 rejected, 1 accepted)** across 55 extracted entities, its Slack workspace is linked, and `/why orin-demo why redis cancelled` returns the cited "Add Redis as a caching layer" rejection (ISSUE-1) from the graph.

---

## Project Structure

```
orin/  (repo folder: codegaurd)
├── bot/                          GitHub App backend + adapters (Node + TypeScript, npm)
│   ├── src/
│   │   ├── index.ts              webhook + HTTP server, event -> queue fan-out
│   │   ├── worker.ts             pg-boss workers: ingest / catch / command / lifecycle
│   │   ├── pipeline.ts           ingest + the precision catch (grounding + semantic gates)
│   │   ├── cognee.ts             Cognee REST client (remember/recall/improve/forget, EBAC)
│   │   ├── llm.ts                DeepSeek extraction + judgment (@ai-sdk)
│   │   ├── ontology.ts           the OWL decision ontology that grounds extraction
│   │   ├── commands.ts           @orinbot command parser + handlers
│   │   ├── slack.ts / linear.ts  the two chat/PM adapters (Bolt / Linear SDK)
│   │   ├── mcp.ts                MCP server: why / check_rejected / record_decision
│   │   ├── preflight.ts          CI pre-flight, metrics, graph endpoints
│   │   ├── auth.ts / dash.ts     dashboard OAuth session + /v1/dash API
│   │   ├── tenant.ts             cross-platform tenant resolution + linking
│   │   ├── db.ts                 Postgres schema, decisions, config, keys, links, docs
│   │   └── delivery.ts           check / review / comment delivery strategies
│   ├── action/action.yml         "Orin Preflight" composite GitHub Action
│   └── test/                     patch / commands / pipeline unit tests
│
├── web/                          Next.js 16 landing + dashboard (React 19, Tailwind 4, Radix)
│   ├── app/dashboard/            session gate, connect hub, the shell
│   ├── components/               dashboard-shell (all views + force graph), landing sections
│   └── lib/orin-api.ts           typed client for /v1/*
│
├── engine/                       self-hosted cognee/cognee (docker compose + env template)
├── deploy/                       Slack app manifest, MCP client config, deploy notes
├── remotion/                     the 3-minute demo video (Remotion project)
├── docs/                         plans (docs/plans) and verification specs (docs/specs)
└── README.md
```

---

## Quick Start

Each folder is its own npm project. You need Node 20+, Docker (for the engine), and Postgres.

```bash
git clone <repo-url> && cd codegaurd

# 1. engine - self-hosted Cognee OSS (needs a PAID LLM key; free Gemini caps too low for cognify)
cd engine && cp .env.example .env    # fill in the LLM key
docker compose up -d                 # cognee REST on :8000 (localhost only)

# 2. bot - the GitHub App backend (needs a registered GitHub App: App ID, private key, webhook secret)
cd ../bot && npm install && cp .env.example .env
npm run dev                          # webhook + API server on :3000
npm test                             # patch / commands / pipeline unit tests

# adapters + MCP run as their own processes off the same build
npm run build && npm run mcp:http    # MCP server (streamable HTTP)
npm run slack                        # Slack Bolt app
npm run linear                       # Linear OAuth app

# 3. web - dashboard + landing
cd ../web && npm install && npm run dev   # http://localhost:3000
```

Register the GitHub App with the webhook URL `<public-origin>/api/github/webhooks`, add the OAuth callback `<public-origin>/v1/auth/callback` for dashboard sign-in, and install it on a repo to trigger the backfill.

---

## Environment Variables

**bot/.env** (see `bot/src/config.ts`):

```
DATABASE_URL=postgres://...                 # Postgres (schema auto-migrates on boot)
COGNEE_BASE_URL=http://127.0.0.1:8000       # the self-hosted Cognee engine
ORIN_SECRET=...                             # HMAC key; also encrypts stored per-tenant Cognee keys
GITHUB_APP_ID=...                           # the registered GitHub App
GITHUB_PRIVATE_KEY_PATH=./github-app.pem    # (or GITHUB_PRIVATE_KEY inline)
GITHUB_WEBHOOK_SECRET=...
GITHUB_OAUTH_CLIENT_ID=...                  # dashboard sign-in (auth routes 404 until set)
GITHUB_OAUTH_CLIENT_SECRET=...
DEEPSEEK_API_KEY=...                        # the bot's own extraction/judgment LLM
WEB_ORIGIN=https://orin-bot.duckdns.org     # default origin for OAuth redirects
```

**web** needs no env to run: it defaults `ORIN_API_ORIGIN` to the live bot and proxies `/v1/*`. On Vercel, set the project Root Directory to `web` and register that domain's `/v1/auth/callback` in the GitHub App.

**engine/.env**: a paid LLM key plus `ENABLE_BACKEND_ACCESS_CONTROL=true`; embeddings default to local `fastembed`.

---

## Tech Stack

| Layer | Tools |
| ----- | ----- |
| Memory engine | self-hosted `cognee/cognee` (Kuzu + LanceDB, EBAC multi-tenant), OWL decision ontology |
| Bot backend | Node.js, TypeScript, `octokit` (GitHub App), `pg` + `pg-boss` (Postgres queue) |
| LLM | `@ai-sdk` with DeepSeek (extraction + judgment); local `fastembed` embeddings in the engine |
| Adapters | `@slack/bolt`, `@linear/sdk`, `@modelcontextprotocol/sdk`, `zod` |
| Frontend | Next.js 16, React 19, Tailwind 4, Radix UI, framer-motion, lucide + simple-icons |
| Auth | GitHub App JWT (webhooks), GitHub OAuth (dashboard), HMAC session cookies |
| Deploy | Azure VM, Caddy, pm2, DuckDNS; Vercel for the web app |

---

## Security Model

| Concern | How Orin handles it |
| ------- | ------------------- |
| Tenant isolation | Every install is a separate Cognee tenant with its own `X-Api-Key`; the bot always calls key-scoped (EBAC). |
| Decisions at rest | Per-tenant Cognee keys are encrypted with `ORIN_SECRET`; the graph lives only on the self-hosted engine. |
| Webhook forgery | Webhooks verified with the App's signing secret (`verifyAndReceive`) before any work is queued. |
| Dashboard sign-in | GitHub OAuth; the token is used once to read installations then discarded. Session is an HMAC-signed cookie (HttpOnly, Secure, SameSite=Lax); CSRF state is bound to a per-browser nonce. |
| Cross-user cache leak | All authenticated `/v1/*` responses send `Cache-Control: private, no-store` + `Vary: Cookie`, so a CDN never serves one user's data to another. |
| Cross-tenant access | Every `/v1/dash/:inst/*` route checks the signed-in user administers that installation; `@orinbot override` is guarded against citing a decision from another repo/thread. |
| Command abuse | Write access required for mutations, admin for `forget`; keys are repo-scoped and stored as SHA-256 hashes (plaintext shown once at mint). |
| Precision (crying wolf) | Two gates before any LLM judgment; only cited, rejected, non-superseded decisions block; silent when evidence is weak. |

---

## For Judges and Reviewers

- **Open Source Cognee, self-hosted.** The engine is `cognee/cognee` (not Cogwit), run with `ENABLE_BACKEND_ACCESS_CONTROL=true`, DeepSeek, and local `fastembed` embeddings. See `engine/` and `bot/src/cognee.ts`.
- **The full Cognee lifecycle, live.** `remember` (ontology-grounded ingest), `recall` (`GRAPH_COMPLETION_COT` + `CHUNKS` + `CODING_RULES` + `TEMPORAL`), `improve` (maintainer feedback reweights the graph hourly), and `forget` (on uninstall). See `bot/src/pipeline.ts` and `lifecycle.ts`.
- **Precision is the product.** The catch runs a deterministic term gate and a semantic-distance gate before any LLM sees it, and only blocks on a cited, rejected, non-superseded decision. `bot/src/pipeline.ts::evaluatePr`.
- **One memory, every surface.** The same tenant graph is reached from a GitHub check, a Slack `/why`, a Linear agent, an MCP `check_rejected`, and a CI pre-flight. Slack and Linear link to a GitHub org's memory with a one-time code.
- **It is live.** Install [`github.com/apps/orinbot`](https://github.com/apps/orinbot), open [`orin-seven.vercel.app`](https://orin-seven.vercel.app), or read the `ydark926/orin-demo` tenant: 12 recorded decisions, and `/why orin-demo why redis cancelled` in the linked Slack returns the cited ISSUE-1 rejection.

---

*Remember the past. Ship the future.*