<p align="center">
  <img src="assets/orin-mark-dark.svg#gh-light-mode-only" alt="Orin" width="84" />
  <img src="assets/orin-mark-light.svg#gh-dark-mode-only" alt="Orin" width="84" />
</p>

<h1 align="center">Orin</h1>

<p align="center">
  <b>Institutional memory for engineering teams. Orin remembers every decision your team makes and catches the ones you are about to repeat, everywhere your team works.</b>
</p>

> A team rejects an idea for a good reason. Months later the person who knew the reason has moved on, the same idea comes back in a new PR, and nobody remembers why you said no. Orin is the memory that does. It reads your repo's closed issues and PRs into a self-hosted Cognee knowledge graph, then catches re-proposals on new PRs and issues with a citation to the original decision, and answers "why did we do X?" from GitHub, Slack, Linear, your IDE, and CI.

Orin is a provider-neutral workspace with connected sources and delivery surfaces. GitHub, Slack, Linear, Google Drive, MCP, CI, and the dashboard all resolve through the same workspace boundary. Teams can start with the tools they use and add another connector without changing who owns the memory.

GitHub remains the deepest decision workflow. It backfills closed issues and pull requests, extracts what was decided and why, and grounds those decisions in a [Cognee](https://github.com/topoteretes/cognee) knowledge graph. Google Drive contributes source-authorized documents to the permission-aware content index. Search and Ask Orin combine only the evidence each member may access. The same workspace can then answer `/why` in Slack, respond in Linear, gate a change over MCP, or stop a repeated proposal in CI. One workspace, flexible sources, permission-safe answers.

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

2. **Switchable connectors and adapters.** Google Drive provides read-only document ingestion with source ACLs. Slack, Linear, and MCP expose the shared decision memory where teams already work. GitHub-compatible workflows can remain enabled without being the workspace identity model.

3. **A self-hosted Cognee engine (`engine/`).** The open-source `cognee/cognee` REST engine with backend access control on, so every tenant's decisions live in a separate, key-scoped graph. Orin drives the full Cognee lifecycle: `remember` (ontology-grounded ingest), `recall` (cited graph completion), `improve` (maintainer feedback reweights the graph), and `forget` (on uninstall).

4. **A permission-aware workspace (`web/`).** A Next.js app where members search and chat across their authorized sources. Owners and admins manage people, roles, groups, feature grants, connectors, source scope, sync health, and audit events. The existing GitHub catches, decisions, rules, docs, graph, keys, and settings remain available in GitHub-compatible workspaces.

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

`bot/src/slack.ts` is a Bolt app. It indexes new and edited messages from public and private channels where Orin is a member, removes deleted messages, and synchronizes channel membership before making content searchable. Channel membership changes update access immediately, and failed access synchronization hides the channel until it recovers. A new Slack-only workspace bootstraps its current human Slack administrator as the first Orin owner. `/why [repo:owner/name] <question>` and `@Orin` use the permission-aware answer path for active workspace members. Automatic warnings are private to the authorized requester, and recording with a brain reaction requires content administration permission. A workspace gets its own isolated memory on install and can be linked to a GitHub org's memory with `/orin link` then `@orinbot link CODE` on GitHub.

### Linear

`bot/src/linear.ts` and `bot/src/linear-content.ts` form a permission-aware Linear connector. OAuth installation uses browser-bound signed state and PKCE. Expiring access tokens and rotating refresh tokens are encrypted and refreshed atomically. Signed, fresh webhooks are durably queued before Orin acknowledges them, while a scheduled sync repairs missed events and refreshes source access.

Issues and their human comments enter the canonical content index. Public teams include active workspace users who can access public teams plus explicit team members. Private and restricted teams include only their current members. Individually shared issues add only the users Linear reports on that issue. Disabled resources, failed ACL refreshes, and ACL snapshots older than 30 minutes fail closed.

An active Orin member can mention `@Orin` in an issue for a cited answer from that same Linear team. Orin checks product permissions, Linear identity, team ACLs, content policies, and citations before replying. It does not post workspace knowledge into an individually shared issue. Current Linear and Orin administrators can create a one-time `@Orin link` code for approval by a GitHub organization owner.

### MCP and CI Pre-flight

`bot/src/mcp.ts` is a Model Context Protocol server (streamable HTTP) exposing three tools that map to the same grounded primitives: **`why`** (cited recall), **`check_rejected`** (returns `{matches, decisionId, comment}` for a proposed change), and **`record_decision`**. It authenticates with a repo-scoped `orin_…` key, so Cursor, Claude Code, or any MCP client can ask Orin before a PR even exists.

For CI, `bot/action/action.yml` is a composite **GitHub Action** ("Orin Preflight") that diffs the PR, POSTs it to `/v1/preflight` with the repo key, and fails the job with an `::error::` (citing the `decisionId`) when the change re-proposes a rejected decision.

### The Dashboard

`web/` is a Next.js 16 app (React 19, Tailwind 4, Radix, framer-motion) with a signed-in, provider-neutral workspace. Members get permission-aware **Search** and **Ask Orin** with source citations and saved conversations. Owners and admins get **People**, **Groups**, **Feature access**, **Connectors**, content policies, sync and access health, resource controls, and an **Audit log**. Google Drive contributes files and source ACLs through incremental synchronization. Slack contributes new channel messages through event-driven ingestion with channel membership ACLs. GitHub-compatible workspaces retain **Catches**, **Decisions**, **Rules**, **Docs**, **Knowledge graph**, **Keys**, and **Settings**. Planned connectors are labeled honestly and do not expose setup actions. The `/v1/*` API is proxied through Next so cookies stay first-party, and authenticated responses are not cached.

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
| **Linear** | Permission-aware issue and comment sync; same-team `@Orin` answers | `bot/src/linear.ts`, `linear-content.ts` |
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
│   │   ├── worker.ts             pg-boss workers: GitHub, Drive, Linear, and lifecycle jobs
│   │   ├── pipeline.ts           ingest + the precision catch (grounding + semantic gates)
│   │   ├── cognee.ts             Cognee REST client (remember/recall/improve/forget, EBAC)
│   │   ├── llm.ts                DeepSeek extraction + judgment (@ai-sdk)
│   │   ├── ontology.ts           the OWL decision ontology that grounds extraction
│   │   ├── commands.ts           @orinbot command parser + handlers
│   │   ├── slack.ts / linear.ts  chat adapters and verified webhook entry points
│   │   ├── linear-content.ts     Linear issue sync, team ACLs, and token rotation
│   │   ├── mcp.ts                MCP server: why / check_rejected / record_decision
│   │   ├── preflight.ts          CI pre-flight, metrics, graph endpoints
│   │   ├── auth.ts / dash.ts     dashboard OAuth session + workspace API
│   │   ├── access.ts / admin.ts  roles, grants, people, groups, and audit routes
│   │   ├── content-db.ts         permission-aware content, ACLs, search, chat, and sync runs
│   │   ├── google-drive.ts       Drive OAuth, crawl, permissions, and incremental sync
│   │   ├── tenant.ts             cross-platform tenant resolution + linking
│   │   ├── db.ts                 Postgres schema, decisions, config, keys, links, docs
│   │   └── delivery.ts           check / review / comment delivery strategies
│   ├── action/action.yml         "Orin Preflight" composite GitHub Action
│   └── test/                     patch / commands / pipeline unit tests
│
├── web/                          Next.js 16 landing + dashboard (React 19, Tailwind 4, Radix)
│   ├── app/dashboard/            session gate, connect hub, the shell
│   ├── components/               workspace, administration, connector, and landing views
│   ├── e2e/                      Playwright permission and workflow coverage
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

Each folder is its own npm project. You need Node 22+, Docker for the engine, and Postgres.

```bash
git clone <repo-url>
cd orin

# 1. engine - self-hosted Cognee OSS (needs a PAID LLM key; free Gemini caps too low for cognify)
cd engine && cp .env.example .env    # fill in the LLM key
docker compose up -d                 # cognee REST on :8000 (localhost only)

# 2. bot backend and queue workers
cd ../bot && npm install && cp .env.example .env
npm run dev                          # API, GitHub webhooks, and queue workers on :3000
npm test                             # patch / commands / pipeline unit tests

# adapters and MCP run in separate terminals after npm run build
npm run build && npm run mcp:http    # MCP server
npm run slack                        # Slack Bolt app
npm run linear                       # Linear OAuth and webhook app on :3002

# 3. web, in another terminal
cd ../web
npm install
ORIN_API_ORIGIN=http://127.0.0.1:3000 \
NEXT_PUBLIC_LINEAR_INSTALL_URL=http://127.0.0.1:3002/linear/install \
npm run dev -- --port 3100
# open http://localhost:3100
```

For local dashboard OAuth, set `WEB_ORIGIN=http://localhost:3100` in `bot/.env`. Register these callbacks for the providers you enable:

- GitHub: `http://localhost:3100/v1/auth/callback`
- Slack: `http://localhost:3100/v1/auth/slack/callback`, with the `openid`, `profile`, and `email` user scopes
- Linear: `http://localhost:3100/v1/auth/linear/callback`
- Google Drive: `http://localhost:3100/v1/connectors/google-drive/callback`

The Linear connector installation callback is separate from dashboard sign-in. Register `http://127.0.0.1:3002/linear/oauth` and set the same value as `LINEAR_REDIRECT_URI`. Linear requires a public HTTPS webhook URL, so local webhook testing also needs a tunnel to port 3002.

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
SLACK_CLIENT_ID=...                         # Slack install and dashboard sign-in
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
SLACK_STATE_SECRET=...
LINEAR_CLIENT_ID=...                        # Linear install and dashboard sign-in
LINEAR_CLIENT_SECRET=...
LINEAR_WEBHOOK_SECRET=...
LINEAR_REDIRECT_URI=http://127.0.0.1:3002/linear/oauth
GOOGLE_DRIVE_CLIENT_ID=...                  # optional Google Drive connector
GOOGLE_DRIVE_CLIENT_SECRET=...
ORIN_LLM_PROVIDER=openai                    # local app-layer LLM
OPENAI_API_KEY=...                          # the bot's OpenAI API key
WEB_ORIGIN=http://localhost:3100             # browser origin for OAuth redirects
```

For local web development, set `ORIN_API_ORIGIN=http://127.0.0.1:3000`. Optional public web variables are `NEXT_PUBLIC_SLACK_INSTALL_URL`, `NEXT_PUBLIC_LINEAR_INSTALL_URL`, and `NEXT_PUBLIC_ORIN_MCP_URL`. On Vercel, set the project Root Directory to `web`, point `ORIN_API_ORIGIN` at the deployed backend, and register every enabled provider's production callback URL.

**engine/.env**: set `LLM_API_KEY` and `EMBEDDING_API_KEY` to your OpenAI API key for local development, with `ENABLE_BACKEND_ACCESS_CONTROL=true`.

---

## Tech Stack

| Layer | Tools |
| ----- | ----- |
| Memory engine | self-hosted `cognee/cognee` (Kuzu + LanceDB, EBAC multi-tenant), OWL decision ontology |
| Bot backend | Node.js, TypeScript, `octokit` (GitHub App), `pg` + `pg-boss` (Postgres queue) |
| LLM | `@ai-sdk` with DeepSeek (extraction + judgment); local `fastembed` embeddings in the engine |
| Adapters | `@slack/bolt`, `@linear/sdk`, `@modelcontextprotocol/sdk`, `zod` |
| Frontend | Next.js 16, React 19, Tailwind 4, Radix UI, framer-motion, lucide + simple-icons |
| Auth | GitHub App JWT, GitHub OAuth, Slack OpenID Connect, Linear OAuth with PKCE, HMAC session cookies |
| Deploy | Azure VM, Caddy, pm2, DuckDNS; Vercel for the web app |

---

## Security Model

| Concern | How Orin handles it |
| ------- | ------------------- |
| Tenant isolation | Every install is a separate Cognee tenant with its own `X-Api-Key`; the bot always calls key-scoped (EBAC). |
| Decisions at rest | Per-tenant Cognee keys are encrypted with `ORIN_SECRET`; the graph lives only on the self-hosted engine. |
| Webhook forgery | Webhooks verified with the App's signing secret (`verifyAndReceive`) before any work is queued. |
| Dashboard sign-in | GitHub, Slack, or Linear can prove identity. Provider tokens used for sign-in are discarded. Sessions use HMAC-signed HttpOnly cookies, provider-bound CSRF state, Slack OpenID token and nonce verification, and Linear PKCE. Workspace membership is checked separately. |
| Workspace access | Active membership, role defaults, group grants, user grants, and explicit denies are evaluated for each API operation. Deny takes precedence. |
| Source permissions | Restricted content must have a current source ACL that matches the user. Stale, failed, or empty ACLs fail closed. Connector, resource, and feature conditions are filtered before results reach the model. |
| Google credentials | OAuth state is signed and bound to the user and workspace. Refresh tokens are encrypted at rest, use read-only scopes, and are removed on disconnect. |
| Linear credentials | Install state is browser-bound and signed, authorization uses PKCE, tokens rotate under a database lock, and revocation disables the connector and fails ACLs closed. |
| Linear answers | Inline answers are limited to the current team, citations are rechecked before delivery, and individually shared issues never receive workspace knowledge in comments. |
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
