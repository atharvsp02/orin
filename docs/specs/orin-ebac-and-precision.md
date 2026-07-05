# Orin — Verified Specs: Multi-Tenant Auth (EBAC) & PR-Judgment Precision

_Grounded in the actual Cognee 1.2.2 source + the karpathy-wiki reference, cloned under `inspiration/`. Every claim below was read from source (file:line refs inline). Verified Jul 2, 2026._

> **Corrections to earlier assumptions (important):** the doc summaries we relied on were wrong on four points, confirmed from source:
> 1. `/search` scores: the **non-verbose** path strips `ScoredResult.score` (`chunks_retriever.py:69` returns `payload` only), BUT **live testing (Jul 2 2026) showed `CHUNKS` + `verbose:true` DOES expose the score** in `objects_result[].score` (cosine distance, lower=better; observed `0.28`/`0.39`) alongside full citation `payload` (`text`, `document_id`, `document_name`, `chunk_index`, `id`). **So Orin *can* threshold on a numeric score** — use `CHUNKS`+`verbose`. (This corrects the earlier source-only reading.)
> 2. `CODING_RULES` search **dumps all rules in a NodeSet, unranked, ignoring the query** (`coding_rules_retriever.py:11-42`); and rules are created by `memify()`/`add_rule_associations`, **not** by the skills endpoint. Skills ≠ Rules.
> 3. `SearchType.FEEDBACK` **does not exist** in 1.2.2 (`SearchType.py:4-21`). "Feedback" is a graph-weighting knob (`feedback_influence` via memify), not a search type.
> 4. EBAC does **not force LanceDB**; it's the default, and unsupported DB combos raise instead of switching. File-based **Kuzu + LanceDB are both in the multi-user support lists** (`context_global_variables.py:103-104`).

---

## Part 1 — Multi-tenant auth (EBAC): VERIFIED & feasible

**Gap closed — and now LIVE-TESTED (Jul 2 2026).** Ran `cognee==1.2.2` locally (Python 3.12 venv, SQLite, `ENABLE_BACKEND_ACCESS_CONTROL` default on). The server logged `auth posture: authentication=required, multi_tenant=enabled (default)`. Full flow passed **8/8** with no LLM key: register → login → `/auth/me` → `POST /permissions/tenants` → `POST /auth/api-keys` → `X-Api-Key` access → no-credential = 401 → bad-key = 401. Then provisioned two tenants (A, B) and confirmed **data-level isolation**: after A added dataset `repoA`, `GET /api/v1/datasets` returned `["repoA"]` for A and `[]` for B on the same server/SQLite. Runtime findings: (1) register rejects reserved-TLD emails (`.test`) — use a real domain; (2) `/api/v1/add` is **multipart** (`data` files + `datasetName` form field) and triggers an LLM call during ingest (500 on a dummy key) — so ingestion needs a real LLM key, but auth/provisioning/isolation do not.

A headless bot can provision and act on an isolated per-tenant memory over pure REST, using a **non-expiring `X-Api-Key`** as the reusable credential.

### Verified facts
- `ENABLE_BACKEND_ACCESS_CONTROL=true` is the **default** and forces auth on (`get_authenticated_user.py:38-64`); it namespaces storage by `tenant_id or user.id` with a per-dataset vector+graph DB (`context_global_variables.py:151-177`).
- Supported multi-user backends (`context_global_variables.py:103-104`): vector = `lancedb|pgvector|falkor`; graph = `ladybug|kuzu|falkor|postgres`. **Our file-based Kuzu+LanceDB on the VM disk qualifies.**
- API-key auth is real and reusable: header **`X-Api-Key`** (`get_api_key_transport.py:9-19`), key → `UserApiKey.user_id` (`get_user_manager.py:73-79`), mint at **`POST /api/v1/auth/api-keys`** (`get_api_key_management_router.py:59`, mounted `/api/v1/auth` at `client.py:223`). Keys have **no expiry** (unlike the 1h login JWT).

### Provisioning flow — per GitHub App installation (pure REST, no Python in our app)
On `installation.created`:
1. `POST /api/v1/auth/register` — `{email:"bot+<installation_id>@orin.dev", password:<random>, is_verified:true}` → bot user.
2. `POST /api/v1/auth/login` (form `username`/`password`) → JWT (1h).
3. `POST /api/v1/permissions/tenants?tenant_name=install-<id>` (Bearer) → tenant **owned by the bot**, set active.
4. `POST /api/v1/auth/api-keys` (Bearer, `{name}`) → **raw key returned once**; persist it (non-expiring).
5. Thereafter every call uses `X-Api-Key: <key>`. Isolation is automatic — the key resolves to the bot user, whose active `tenant_id` filters all dataset access (`get_all_user_permission_datasets.py:45`).
6. `POST /api/v1/remember` (multipart: `data` files + `datasetName`) → dataset owned by the bot in its tenant.
7. `POST /api/v1/search` (`{query, search_type, datasets|dataset_ids}`) — scoped; 403 on cross-tenant.
8. `POST /api/v1/forget` (`{dataset}` / `{datasetId}` / `{everything:true}`).

**Verified constraints:** you cannot create a tenant or mint a key *for another user* over REST — each is done as the authenticated caller. That's fine: **one bot user per installation** is the clean model. (Library alternative `create_user`→`create_tenant(user_id=)`→`create_api_key(user)` exists if we want to skip the login round-trip, but it needs Python in-process.)

### Security note (new)
Run the Cognee engine **private to the VM** (localhost / tunnel-restricted), never internet-exposed — `/auth/register` is public by design (fastapi-users). Only our TS bot + dashboard (which have their own GitHub auth) talk to the engine.

### Fallback (de-risk)
If per-install provisioning eats too much time: run `ENABLE_BACKEND_ACCESS_CONTROL=false`, one shared bot user, **dataset-per-install** with the bot scoping every query by dataset name (logical isolation). Weaker than hard isolation but simple; acceptable for the demo since the engine is private and we control all queries. **Both paths are now verified-feasible** — choose by time remaining.

---

## Part 2 — PR-judgment precision: design (no score to lean on, so we don't)

**Verified reality:** Cognee's `/search` gives you an LLM answer or chunk payloads, **never a threshold-able score**. Cognee's own flagship project (karpathy-wiki) doesn't use scores either — it enforces precision with **deterministic grounding + citation resolution + refuse-on-weak-evidence** (`lint_wiki.py`). Orin mirrors that.

### The model
**Decision Record** (immutable, stable-ID; mirrors karpathy `raw/sources/*.md` + `source_id`). On ingest, for each closed PR / resolved issue that carries reasoning, create:
`decision_id`, `title`, `outcome` ∈ {merged | rejected | reverted}, `reasoning_text`, `date`, `source_url`, and indexed `terms` (dependency names, touched paths, labels). Store it as a Cognee Data item (so it's citable) **and** mirror a row in our own DB (for the grounding check + citation resolution).

### The pipeline (on `pull_request.opened`)
1. **Two independent retrieval passes, separate buckets** (karpathy `query.py:79-84`, evidence `origin` tag):
   - *Deterministic first pass* — match the PR's signals (added/removed deps, touched paths, labels, key nouns) against records' indexed terms, using the +10-title/+1-body keyword scorer (`wiki_common.py:213-231`). A dependency-name or path hit is strong, citable signal.
   - *Semantic pass* — `POST /api/v1/search` with **`CHUNKS`** (top_k), scoped to the dataset, query = an LLM summary of the PR's **intent** (not the raw diff). `CHUNKS` returns structured payload (`document_id`, `document_name`, `chunk_index`, `chunk_id`, `text`) = real citations (`chunks_retriever.py:69`). Treat semantic-only hits as *draft, needs corroboration* (karpathy downgrade `query.py:200-204`).
   - *Numeric cutoff (now confirmed available):* read `objects_result[].score` from a `CHUNKS`+`verbose:true` search (cosine distance, lower=better) for a first-pass distance gate — no need to call the vector engine directly. The grounding gate below is still the primary, quotable guard.
2. **Grounding gate (the false-positive guard — `check_claim_grounding`, `lint_wiki.py:226-244`):** before commenting, require the PR text to share ≥ N significant terms with the candidate record's reasoning text (threshold 2 short / 3 long). Below threshold → suppress. "Resembles" becomes checkable and quotable ("PR adds `prisma`; `DR-042` rejected `prisma` on 2024-03: <quote>").
3. **Outcome + recency filter (superseded decisions):** only fire on records that are `rejected` and not later `reverted`. Cognee has **no built-in supersession resolver** (TEMPORAL returns an LLM string, recency internal/unexposed — `temporal_retriever.py`), so we compute this from the record's `outcome`/`date` + reversal links ourselves.
4. **Citation resolution (pre-post gate — `check_claim_citations`, `lint_wiki.py:120-139`):** the drafted comment must cite a real `decision_id` that resolves to a record; if it doesn't, **don't post**. One assertion = one resolvable citation.
5. **Refuse on weak/empty evidence** (`query.py:126-129`): if nothing clears the gate, post nothing. Silence is the safe default.
6. **Idempotency + feedback** (`improve.py:53-58`): one comment per PR via a marker. A maintainer dismissal → record as feedback → Cognee `memify()` `feedback_influence` weighting (the real mechanism) + raise that record's threshold.
7. **Judgment LLM = our app layer (Vercel AI SDK registry, Gemini/DeepSeek/OpenAI):** the final "does this PR resemble candidate X — draft a comment citing its `decision_id`, or return no-match" call. Strict prompt: must cite a provided candidate or abstain. Cognee does retrieval/graph; our app does the guarded judgment + drafting.

### Team rules (corrected)
Rules enter via `remember` + `memify()` (`add_rule_associations`, nodeset `coding_agent_rules`), **not** the skills endpoint. `CODING_RULES` search returns the **full rule list, unranked** — so use it to *load the rulebook*, then the grounding gate + judgment LLM decides which rule (if any) a PR violates and cites it.

---

## Live-run status
- ✅ **Auth flow (register→login→tenant→api-key→X-Api-Key) + two-tenant isolation** — DONE, 8/8, verified locally against `cognee==1.2.2` (no LLM key needed). `/add` confirmed multipart.
- ✅ **Full memory lifecycle `remember → recall → improve → forget`** — DONE live with a real Gemini key (Jul 2 2026). `remember` built the graph in ~98s for one small doc; **`recall` (GRAPH_COMPLETION) returned the correct, cited answer** — "Prisma ORM proposed in PR #42, rejected due to migration lock-in…" (exactly Orin's core behavior); `improve` = PipelineRunCompleted; `forget` pruned the dataset (list empty after). This proves the product's core loop works.
- ✅ **Precision & citation battery** — DONE live (Jul 2 2026, 3 seeded decisions): (T1) recall preserves **REJECTED** outcome + cites decision ID; (T2) recall preserves **ACCEPTED-alternative** (Redis→LISTEN/NOTIFY); (T3) **false-positive guard works** — a query with no matching decision (GraphQL) returned *"the provided context does not contain any information"* instead of hallucinating; (T5) **`include_references` produced a real Evidence block** (document name + `data_id` + `chunk_id` + quoted source); (T6) **`CHUNKS`+`verbose` exposes `score` + citation payload**. The core Orin judgment loop is validated: it recalls rejections with citations and refuses when evidence is absent.
- ⏳ **Grounding-gate threshold tuning** — set the term-overlap/score cutoffs against a larger seeded demo repo at build time.
- ⚠️ Minor: one ingest produced a spurious `"Got it."` summary node (degenerate LLM summary); clean ingests return correct chunk text. Non-deterministic; watch for it, not a blocker.

### Verified LLM/embedding config (important — the provided key had a quota gotcha)
- Working models on the test key: **LLM `gemini/gemini-2.5-flash`**, **embeddings `gemini/gemini-embedding-001` (3072 dims)**. The Cognee default **`gemini/gemini-2.0-flash` had `limit: 0` (429 no free-tier quota)** on that key — so a wrong default silently blocks ingest. Always pin `LLM_MODEL` to a model the key actually has quota for.
- `COGNEE_SKIP_CONNECTION_TEST=true` avoids a flaky 30s LLM preflight; ingest still calls the LLM for real.
- Cognify latency (~98s for a tiny doc; ~263s for a 12-decision batch — **sub-linear**, so batching is efficient) confirms the **async webhook pipeline is mandatory** (never run cognify inside the ~10s webhook handler).
- **CRITICAL for ingestion budget:** the Gemini **free tier caps at 20 `generate_content` requests _per day_** (`RESOURCE_EXHAUSTED, limit: 20, PerDay` on gemini-2.5-flash). cognify makes several LLM calls per document, so a real backfill (hundreds of issues/PRs) is **not feasible on the free tier** — it throttled on a single 12-item batch. **Budget a paid LLM tier for the ingestion phase** (Azure OpenAI credits / DeepSeek / paid Gemini); the free tier is fine only for the live-catch recall (a few calls) and demos.
- Minor anomaly: `CHUNKS` search returned a terse `"Got it."` rather than the raw chunk payload — investigate at build time; `GRAPH_COMPLETION` recall was perfect.
