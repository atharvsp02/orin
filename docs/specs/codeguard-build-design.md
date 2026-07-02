# CodeGuard — Master Build & Design Spec

_The **how** (companion to `docs/plans/codeguard-roadmap.md`, the what/why). Every API/mechanism below was verified against source (`inspiration/cognee` 1.2.2) or official platform docs; reference SDKs are cloned under `inspiration/` (`mcp-typescript-sdk`, `bolt-js`, `linear-agent-demo`)._

> **LIVE-VERIFIED (Jul 2 2026) — ran the whole Cognee-side design against a running engine before implementing:**
> - ✅ **Feedback loop end-to-end**: recall-with-`sessionId` writes a QA entry; `GET /sessions/{id}` exposes `qa_id` + a populated `used_graph_element_ids`; `POST /remember/entry` (feedback) → 200; `POST /improve` → `PipelineRunCompleted`.
> - ✅ `GRAPH_COMPLETION_COT`, `CODING_RULES` (seed via `/remember node_set` + retrieve), `visualize` (returns HTML), all 9 endpoints + fields present.
> - ✅ **Confirmed Python-only**: `POST /memify` with a task-name string → HTTP 500 `WrongTaskTypeError` (rule *mining* is not reachable over REST — seed rules instead).
> - ⚠️ **CASING CORRECTION** (implement to these exact names): `recall`/`search`/`improve`/`memify` JSON = **camelCase** (`sessionId`, `searchType`, `includeReferences`, `topK`, `datasets`, `nodeName`, `sessionIds`, `datasetName`, `extractionTasks`). `remember/entry` wrapper + `FeedbackEntry` = **snake_case** (`session_id`, `dataset_name`, `qa_id`, `feedback_score`). `/remember` form fields = snake (`node_set`, `datasetName` form). `visualize` query param = `dataset_id`. (Snake also works on the camel endpoints via Pydantic aliases, but use the declared names.)
> - Not runtime-tested: TEMPORAL behavior + ontology upload (endpoints/fields confirmed present) and the GitHub delivery layer (needs a real repo — deferred; verified vs GitHub's live API docs).

## 0. The one invariant (read first)

Every surface — GitHub, MCP, Slack, Linear, CLI — is a **thin adapter that only ever calls four core functions: `ask` / `ingest` / `warn` / `resolveTenant`.** The precision-critical decision logic lives in exactly one place. **Build Phase-0 features on today's `bot/` structure; do the `core/` extraction only when the second surface (MCP) lands** — the refactor is behavior-preserving plumbing, not new value.

---

## 1. Target architecture

```
 GitHub webhooks ─▶ adapters/github (Octokit App + pg-boss + delivery)
 Slack events    ─▶ adapters/slack  (Bolt-JS + install store)      ┐  thin shells:
 Linear webhooks ─▶ adapters/linear (agent sessions + @linear/sdk) ├─ parse event → resolve tenant
 IDE agents      ─▶ adapters/mcp    (MCP SDK: stdio + HTTP+OAuth)  │  → call ONE primitive → render
 CI / shell      ─▶ adapters/cli    (MCP client → check_rejected)  ┘
                                    │  (only ask / ingest / warn / resolveTenant)
              ┌─────────────────────▼──────────────────────┐
              │  core  —  ask() ingest() warn() resolveTenant() │
              │  pipeline · llm · cognee(REST) · db · crypto │
              └───────┬─────────────────────────┬───────────┘
              Postgres (installations,           Cognee engine
              tenant_config, decision_records,   (per-tenant X-Api-Key,
              tenant_links, deliveries)          isolated dataset, Docker)
```

**Invariants:** (1) an adapter turns a platform event into `(tenantRef, text|item)`, calls one primitive, renders the reply — it never touches Cognee/LLM/SQL directly. (2) `resolveTenant(ref)` is the single place a platform identity (`github:install:123`, `slack:team:T0AB`, …) maps to one Cognee tenant — this is what lets a decision recorded from a GitHub PR surface in a Slack `/why`. (3) Long work is enqueued on the shared pg-boss queue so every platform's ack window (GitHub instant, Slack 3s, Linear 5s) is met by enqueue-then-reply-later.

---

## 2. Data-model evolution

| Table | Change | Purpose |
|---|---|---|
| `tenant_links` | **NEW** `(platform, external_id) → installation_id` | map any platform identity to the one Cognee tenant; GitHub short-circuits to `installationId` |
| `deliveries` | **replaces `pr_comments`**; PK `(installation_id, repo, number, head_sha)`; `mode check\|review\|comment`, `check_run_id/review_id/comment_id`, `state posted\|clear\|overridden\|ignored`, **`session_id`** | idempotent per-commit delivery + the feedback session link |
| `preflight_keys` | **NEW** `(key_hash, installation_id, repo)` | repo-scoped CI/pre-flight auth (sha256-hashed `cg_…` keys) |
| `decision_records` | unchanged (already has `superseded_by`) | — |

---

## 3. Engine config (`engine/.env`) — two required additions

- **`DEFAULT_FEEDBACK_INFLUENCE=0.15`** — REQUIRED for feedback to affect retrieval. Default is `0.0` (`base_config.py:19`), at which `apply_feedback_weights` still writes weights but `CogneeGraph._effective_distance` short-circuits (`CogneeGraph.py:482`) and ranking ignores them.
- **`AUTO_FEEDBACK=false`** (optional) — default `True` (`cache/config.py`) adds one extra LLM call per answered turn (quota). Disable unless you want Cognee's auto-feedback heuristic.
- Ontology (Part B5): upload via `/api/v1/ontologies` or mount an `.owl` in the `/data` volume.

---

## 4. Part A — GitHub delivery & triggers

### A1. Delivery abstraction — **Check Run is the enforcement surface; Review is the inline UX; comment is fallback**
Critical correctness point: **a `REQUEST_CHANGES` review from a GitHub App does NOT block merge** unless the App is a required reviewer/CODEOWNER. The reliable merge gate is a **Check Run with `conclusion:"failure"` registered as a required status check** (`success/neutral/skipped` satisfy it; `failure/action_required` block).

```ts
interface Delivery {
  open(ctx): Promise<DeliveryRefs>;                       // checks.create status=in_progress
  publish(ctx, prior, decision): Promise<DeliveryRefs>;   // findings → check/review/comment
  clear(ctx, prior): Promise<DeliveryRefs>;               // no findings → conclusion=success
  override(ctx, prior, by, reason): Promise<DeliveryRefs>;// conclusion=success + note
}
resolveDelivery(cfg): Delivery   // cfg.deliveryMode, fallback check→review→comment on 403/404/422
```
- **CheckRunDelivery** — `checks.create` (`head_sha`, `name:"CodeGuard"` = the required-check context, `status:"in_progress"`, `external_id`) → `checks.update` (`status:"completed"`, `conclusion: blocking ? "failure" : "neutral"`, `output.{title,summary,text}` + `output.annotations` **≤50/request**, `annotation_level notice|warning|failure`). New check run **per `head_sha`** (a run is bound to one commit).
- **ReviewDelivery** — `pulls.createReview` (`commit_id: head_sha`, `event: blocking ? REQUEST_CHANGES : COMMENT`, `comments[]` anchored via `path`+`start_line/start_side`+`line`+`side`) with a ```suggestion``` block (fence widens to ```` ```` ```` when the replacement itself contains backticks). Reviews aren't editable → on re-run `dismissReview` the stale one, repost.
- **Anchoring (`patch.ts`, pure/unit-testable)** — parse `pulls.listFiles` unified-diff hunks (`@@ -a,b +c,d @@`), walk lines tracking head/base line + side (`+`→RIGHT/head, `-`→LEFT/base, ` `→both); `anchorFor(files, terms)` scores added (RIGHT) lines by overlap with the decision's `terms` (reuse `pipeline.grounded`'s tokenizer) and picks the best contiguous run. Anchors must be diff lines or GitHub 422s.

### A2. Required-status-check gate (lifecycle)
`opened/reopened/ready_for_review` → create check `in_progress`; catch completes clean → `success` (unblocks); re-proposal + `cfg.blockOnRepropose && !draft` → `failure` (blocks); advisory/draft → `neutral`; `synchronize` → new check for the new `head_sha`; `override` → `success`. One-time manual step: repo admin adds context `CodeGuard` to branch protection (don't auto-register — needs `Administration:write`).

### A3. Trigger expansion
Subscribe `pull_request` `opened`(incl. draft)/`reopened`/`ready_for_review`/`synchronize`, and `issues.opened` (run the same catch on issue title/body — stop a dead-end before code). Idempotency keyed by `head_sha` in `deliveries`. **New App permissions:** Checks **R/W (new)**, Pull requests **R→R/W**, Issues **R→R/W**; subscribe Pull request / Issues / Issue comment events.

### A4. Slash commands (`@codeguard …`) + the override→supersede loop
`issue_comment.created` → parse `@codeguard (recall|why|override|ignore|re-scan)`; ack with an `eyes` reaction (`reactions.createForIssueComment`), swap to `rocket` on success. Auth for mutating cmds via `repos.getCollaboratorPermissionLevel` (`admin|write` or an allowlist).
- **`override "<reason>"`** is the killer loop: mint a NEW `accepted` decision that **supersedes** the cited rejection — reuse the ingest path: `cognee.remember` + `db.upsertDecisionRecord({outcome:"accepted", supersedes…})` + `db.markSuperseded(inst, [citedRef], newId)`. The future `evaluatePr` then filters the now-superseded rejection out automatically, and `delivery.override` flips the check green.

### A5. Contributor pre-flight (shift-left)
`POST /v1/preflight` on the same HTTP server (route in front of `createNodeMiddleware`); body `{repo,title,description,diff}`; auth **repo-scoped `cg_…` key, sha256-hashed at rest** (never a GitHub token in CI) → `evaluatePr` with NO GitHub writes → JSON findings. A ~30-line composite **GitHub Action** and a **CLI** both POST the same endpoint (single source of truth); Action exits non-zero on `blocking:true`.

**Build order (A):** `patch.ts` → `github.ts` (`fetchPr → PrSnapshot` w/ `head.sha`+patch+draft) → `deliveries` table → `CheckRunDelivery`+fallback comment (ships the gate) → `buildDecision` (anchors + `blocking`) → `ReviewDelivery`+suggestions → trigger expansion → slash commands+override → pre-flight+Action+CLI.

---

## 5. Part B — Cognee lifecycle deepening

### B1. Four-verb lifecycle + feedback learning (the flagship "Best Use of Cognee")
The full chain, all REST-native (verified). **Key discovery: feedback rides on `/api/v1/recall` (which has `session_id`), NOT `/api/v1/search` (which doesn't).**
1. **Catch recall** → `POST /api/v1/recall` `{query, searchType:"GRAPH_COMPLETION_COT", datasets:[ds], sessionId:"codeguard-pr-<inst>-<n>", includeReferences:true, topK:10}` (camelCase) → engine writes a QA entry with `used_graph_element_ids` (`graph_completion_retriever.py:351-364`, live-confirmed). Store the session id on the delivery row.
2. **Maintainer 👍/👎** (reaction or `@codeguard good|bad`) → recall doesn't return `qa_id`, so `GET /api/v1/sessions/{session_id}` → match the QA by `question` → read `qa_id` → `POST /api/v1/remember/entry` `{entry:{type:"feedback", qa_id, feedback_score}, session_id, dataset_name}` (score **int 1–5**; 👍=5, 👎=1).
3. **Hourly `lifecycle` worker** → `POST /api/v1/improve` `{datasetName, sessionIds:[…]}` (camelCase) → applies feedback weights (EMA `w += 0.1·(rating−w)`) to the exact nodes/edges that produced the answer; higher weight → lower effective distance → ranked higher.
4. **`forget()`** wired to an event (e.g. `installation.deleted` → prune tenant, or `@codeguard forget`) so **all four verbs fire live**.

New `cognee.ts`: `recallWithSession`, `getSessionQAs`, `addFeedback`, `improve`, `visualize`, `uploadOntology`. New `bot/src/lifecycle.ts` + a `feedback` queue. **Effort L**, but every endpoint exists.

### B2. `GRAPH_COMPLETION_COT` for the catch recall
One-line `search_type` swap — an iterative reason→re-retrieve loop that re-surfaces a prior rejection even when the PR rewords it. Caveat: `max_iter` is **fixed at 4 over REST** (`retriever_specific_config` isn't exposed) — fine for catch. **Effort S** — do this first.

### B3. CODING_RULES — enforcement REST-native; mining Python-only
- **Enforce** now: `search_type:"CODING_RULES"`, `node_name:["coding_agent_rules"]` (returns raw rule strings; we compare). Add to `cognee.ts:search`.
- **Mine** (dedup): `add_rule_associations` is a **Python task with no REST route** — `/memify` accepts task-name strings but there's no string→task registry (`run_pipeline` rejects non-`BoundTask`). Two options: **(1)** add a small engine-side router that calls `add_rule_associations(chunks, "coding_agent_rules")` (true LLM dedup, needs an image change); **(2, recommended for TS-only)** do rule extraction in our `llm.ts`, then seed via `POST /api/v1/remember` `node_set:["coding_agent_rules"]`. **Effort M** (enforce+seed) / L (engine miner).

### B4. `visualize()` for the dashboard
`GET /api/v1/visualize?dataset_id=<UUID>` → interactive graph **HTML** (dataset UUID from `GET /api/v1/datasets`); embed as an iframe per repo. (`/visualize/multi` is superuser-only — skip.) **Effort S.**

### B5. Per-repo decision ontology
`POST /api/v1/ontologies` (multipart `.owl` + `ontology_key`) → reference at ingest via `remember`'s `ontology_key` field. Proposed ontology: classes `Decision/Rejection/Rule/Component/Reviewer`; relations `supersedes/applies_to/rejected_because/decided_by`. Grounds extraction and models supersession **in the graph** (reinforcing the DB `markSuperseded`). **Effort M** (mostly authoring the `.owl`).

### B6. TEMPORAL — filtering only, no decay
`search_type:"TEMPORAL"` works over REST for date-scoped queries ("what did we reject in Q1?"), BUT: (a) `temporal_cognify=true` **ingestion is Python-only** (no REST field), and (b) there is **no recency decay** in the retriever. **Keep decay in OUR grounding-gate scoring** (down-weight candidates by `decidedAt` age); don't rely on Cognee for recency ranking. **Effort S** (search only).

**Flags:** feedback off-by-default env; recall doesn't return `qa_id` (GET-sessions round-trip); `feedback_alpha` fixed 0.1; COT `max_iter` fixed 4; rule-mining + temporal-ingestion Python-only.

**Build order (B):** `engine/.env` + COT swap (S) → feedback lifecycle (L) → visualize (S) → ontology (M) → CODING_RULES (M) → TEMPORAL optional (S).

---

## 6. Part C — Decision core refactor + platform adapters

### C1. Core extraction (npm workspaces, minimal churn)
`pipeline.ts` already *is* the core. Move `cognee/llm/db/crypto/config/types/pipeline` → `core/src` (unchanged), add `primitives.ts` (`ask/ingest/warn`) + `tenant.ts` (`resolveTenant/provisionAndLink`); `github.ts`→`adapters/github`, `index.ts`/`worker.ts`→`adapters/github`. Root `package.json` `workspaces:["core","adapters/*"]`, still `tsc`/ESM. **Guard with a golden test on `evaluatePr` before/after — it's the precision crown jewel.**

### C2. Tenant abstraction
`Tenant {installationId, datasetName, creds, cfg, cog}`; `TenantRef {platform, externalId}`; `resolveTenant(ref)` via `tenant_links` (GitHub short-circuits to the numeric id, zero migration); `provisionAndLink(ref, opts)` for new adapters (creates or links a Cognee tenant). The three primitives are today's `evaluatePr`/`ingestItem` with the `(inst,cfg,creds)` triple collapsed to `Tenant` and `RepoItem` generalized to a platform-neutral `IngestItem`; `ask` is the new read-side twin.

### C3. MCP adapter — **build thin over `core`, do NOT wrap `cognee-mcp`**
`cognee-mcp` exposes raw `remember/recall/forget` (wrong abstraction — it would bypass our grounding gate/supersession). Expose CodeGuard tools mapping 1:1 to the primitives: `ask_decision`→`ask`, `check_rejected`→`warn`, `record_decision`→`ingest` (Zod schemas; SDK peers Zod). Transports: **stdio** (local, one process/tenant, key from env) and **streamable HTTP + OAuth 2.1** (remote, `Mcp-Session-Id` map, per-tenant scope from the token, DNS-rebinding protection). Critical: the server calls Cognee with the **tenant's own key, never the client's OAuth token** (spec-mandated). SDK: `@modelcontextprotocol/sdk` (`inspiration/mcp-typescript-sdk`). **Effort M** — unlocks every IDE agent *and* the CLI.

### C4. Slack adapter (Bolt-JS)
Multi-workspace OAuth v2; `installationStore` keyed by `team.id` → `provisionAndLink({platform:"slack", externalId:team.id})` on install. Handlers: `/why` (`ack()` <3s → `respond()` async with cited Block Kit), `reaction_added :decision:` → `ingest` the thread, top-level `message` collision-`warn`. Enqueue LLM work on pg-boss so acks never block. Scopes: `commands, chat:write, reactions:read, channels:history, app_mentions:read`. **Effort L.** (`inspiration/bolt-js`)

### C5. Linear adapter (agent sessions)
Install `actor=app` with `app:mentionable`/`app:assignable`; enable agent-session-events webhook. On `AgentSessionEvent(created)`: reply 200 **<5s**, emit a `thought` **<10s** via `agentActivityCreate`, then do the work and emit a `response` with citations; `prompted` for follow-ups. Also `warn`-on-issue-create → comment. SDK `@linear/sdk`. **Effort M** (`inspiration/linear-agent-demo`).

### C6. CLI (CI gate)
Thin MCP client over the **same remote HTTP endpoint** → `check_rejected` → non-zero exit on a match. `codeguard --file <(git log -1 --format=%B)`. **Effort S.**

---

## 7. Consolidated phased build order

**Phase 0 — hackathon (maximize judging, on today's `bot/`):**
1. `engine/.env`: `DEFAULT_FEEDBACK_INFLUENCE=0.15`, `AUTO_FEEDBACK=false`.
2. Swap catch recall → `recallWithSession(GRAPH_COMPLETION_COT, session_id)` [B2+B1.1].
3. Feedback ingress (reaction/comment → `addFeedback`) + hourly `improve` worker + `forget` on an event → **all four lifecycle verbs fire live** (Best Use of Cognee) [B1].
4. **Check Run gate** + inline review + evidence panel + **"PRs prevented" metric** + `visualize()` graph [A1/A2 + roadmap].
5. `CODING_RULES` enforcement + seed rules via `/remember node_set` [B3].

**Phase 1 — product v1:** full `delivery.ts` (review + suggestions), trigger expansion (draft/issue), slash commands + override→supersede, pre-flight + Action + CLI, ontology, revert-awareness.

**Phase 2 — scaling:** core extraction → MCP (stdio → HTTP+OAuth) → CLI → Slack → Linear → dashboard/analytics.

---

## 8. Cross-cutting caveats (must-know before building)
- **Check Run, not Review, is the merge gate.**
- **Feedback** needs recall-with-`session_id` + `DEFAULT_FEEDBACK_INFLUENCE>0` + a GET-sessions round-trip for `qa_id`.
- **Rule mining** and **temporal ingestion** are **Python-only** (no REST); **enforcement/temporal search** are REST-native; **COT `max_iter` fixed 4** over REST; **TEMPORAL has no decay** (keep it in our scorer).
- **Build MCP over `core`, don't wrap `cognee-mcp`.**
- The core refactor must be **behavior-preserving** (golden-test `evaluatePr`).
- **Precision is existential** — false positives kill an interruptive bot's trust; keep the grounding gate + refuse-on-weak-evidence + human override sacred.

_Sources: reference SDKs cloned in `inspiration/` (mcp-typescript-sdk, bolt-js, linear-agent-demo, cognee 1.2.2); platform docs (GitHub Checks/Reviews/Reactions APIs, MCP authorization spec, Slack Bolt, Linear Agent Interaction) — full URL lists in the research streams that produced this spec._
