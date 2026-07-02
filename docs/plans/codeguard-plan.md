# CodeGuard — Master Build Plan

_Cognee "Hangover Part AI" Hackathon · **Open Source track** (self-hosted Cognee OSS → MacBook) · deadline **Jul 5, 2026** · ~3 days left · today Jul 2._

**One-line pitch:** an institutional-memory GitHub App for open-source maintainers — it remembers every past PR rejection and architectural decision, answers onboarding questions with citations, and comments on new PRs that re-propose something already tried and rejected.

Deep verification details live in `docs/specs/codeguard-ebac-and-precision.md`. Source + reference repos are cloned under `inspiration/` (`cognee` 1.2.2, `karpathy-wiki`).

---

## 0. Status ledger — what's proven vs. what's left

| Area | Status | Note |
|---|---|---|
| Multi-tenant EBAC auth (register→tenant→`X-Api-Key`→isolation) | ✅ **live-verified** | 8/8 + two-tenant data isolation, run locally |
| Full memory lifecycle (remember→recall→improve→forget) | ✅ **live-verified** | correct cited recall on real Gemini |
| Precision: outcome-awareness, false-positive refusal, citations, score | ✅ **live-verified** | see §9 |
| Working LLM/embedding config | ✅ **live-verified** | `gemini-2.5-flash` + `gemini-embedding-001` (3072d) |
| **Ingestion needs a PAID LLM tier** | ✅ **confirmed constraint** | free Gemini caps at **20 generations/day** |
| Cognee runs self-hosted with no Docker/sudo (venv) | ✅ **live-verified** | production still uses the Docker image on the VM |
| GitHub App mechanics (perms, webhooks, install token, `/user/installations`) | 🧩 docs-verified | not exercised — deferred by choice |
| Async pipeline design | 🧩 **designed** (§7) | build + load-test on VM |
| Data model | 🧩 **designed** (§6) | build on VM |
| Catch-refinement (re-proposal linking, reversal handling) | ⏳ pending | blocked by exhausted daily quota; retry w/ paid key |
| GitHub App registration / webhook / comment posting | ⛔ deferred | user's choice — do when ready to touch GitHub |

---

## 1. Track compliance
Open Source track = **self-hosted Cognee OSS, not Cogwit**. We run the `cognee/cognee` engine ourselves with our own LLM/vector/graph config. Only calling Cognee's managed cloud API (`cognee.serve(url="https://…cognee.ai")`) would disqualify. Cloud hosting (Azure VM) is just compute — fully compliant. **README must state this explicitly.**

## 2. The three repositories (don't conflate)
| Repo | Role | Whose |
|---|---|---|
| **Project repo** | CodeGuard's source + submission | **yours** |
| **Demo/target repo** | what the App is installed on; where the staged PR is opened | **yours** (installing an App + opening PRs needs admin) |
| `topoteretes/cognee` (public) | optional **read-only** ingest for the recall wow-factor | not yours |

The live-catch demo runs on a repo you control (seed it with realistic maintainer decisions). Cognee's public issues/PRs can be ingested read-only to show recall on a real codebase — no install needed.

## 3. Architecture
```
User repo(s) ─webhook→  CodeGuard bot (TS, Octokit App) ─REST(:8000)→  cognee/cognee engine
  (install App)           on Azure VM · pm2/systemd                      on same Azure VM
                               │  ack 202, enqueue job                   Kuzu+LanceDB+SQLite (file-based)
                          pg-boss queue (Postgres) ← worker              EBAC=true, dataset per install
Vercel dashboard (Next.js) ────┘  login w/ GitHub · upload docs · rules · provider · graph stats
```
- **Host:** one always-on **Azure VM** (B2s on credits; persistent disk; snapshot before judging) runs the Docker engine **and** the TS bot (pm2/systemd). Rationale: file-based store + webhook listener need persistence + a stable URL; serverless would lose both. Fully OSS-track compliant.
- **Stable HTTPS webhook:** Cloudflare Tunnel. **Engine stays private to the VM** (`/auth/register` is public — never expose the engine to the internet).
- **Storage:** file-based Kuzu+LanceDB+SQLite on the VM disk — no external vector/graph DB. A small Postgres (or SQLite) holds *our* app tables (§6) + the pg-boss queue.

## 4. Multi-tenant auth (EBAC) — verified flow
`ENABLE_BACKEND_ACCESS_CONTROL=true` (default) forces auth and isolates graph+vector per dataset by `tenant_id`. Reusable headless credential = a **non-expiring `X-Api-Key`**. Per installation (`installation.created`):
1. `POST /api/v1/auth/register` `{email, password, is_verified:true}` → bot user
2. `POST /api/v1/auth/login` (form) → JWT
3. `POST /api/v1/permissions/tenants?tenant_name=install-<id>` (Bearer) → tenant (bot owns it)
4. `POST /api/v1/auth/api-keys` (Bearer) → **store the key** (non-expiring)
5. thereafter `X-Api-Key: <key>` on every call — active tenant auto-filters datasets (cross-tenant = 403)

Constraint: one bot user per installation (can't mint keys/tenants for another user over REST). Fallback if provisioning runs long: EBAC off + one user + dataset-per-install (logical isolation).

## 5. LLM strategy (two layers)
- **Layer A — engine memory LLM** (cognify extraction, recall generation) routes through **LiteLLM**. Gemini native; DeepSeek via `custom`. Verified working: `LLM_MODEL=gemini/gemini-2.5-flash`, `EMBEDDING_MODEL=gemini/gemini-embedding-001` (3072d). **Pin the model** — Cognee's default `gemini-2.0-flash` had zero quota. Set `COGNEE_SKIP_CONNECTION_TEST=true`.
- **Layer B — app LLM** (comment drafting, PR-resemblance judgment, per-tenant provider choice) uses the **Vercel AI SDK** registry (`@ai-sdk/google|openai|deepseek`).
- **⚠️ Ingestion budget (confirmed):** free Gemini = **20 generations/day** → real backfill MUST use a **paid tier** (Azure OpenAI credits / DeepSeek / paid Gemini). Free tier is fine for live-catch recall + demos only. Batching is efficient (sub-linear: 12 docs ≈ 263s), so the cost driver is per-item LLM calls, not wall-clock.
- Per-tenant provider only cleanly applies at Layer B (engine LLM config is process-global) — known limit.

## 6. Data model
**Our DB (Postgres on the VM; small):**
- `installations` — `installation_id` PK, `github_account`, `dataset_name`, `cognee_api_key` (encrypted), `created_at`
- `repos` — `installation_id` FK, `repo_full_name`, `backfill_status`, `backfill_cursor`
- `tenant_config` — `installation_id` FK, `tone`, `watch_paths[]`, `confidence_threshold`, `score_cutoff`, `auto_comment` bool, `custom_instructions`, `llm_provider`
- `decision_records` — `decision_id` PK, `installation_id`, `source_type` (pr|issue|doc), `source_url`, `title`, `outcome` (merged|rejected|reverted), `reasoning_text`, `decided_at`, `terms[]` (deps/paths/labels), `superseded_by`, `cognee_data_id`, `created_at` — the mirror used for the grounding gate + citation resolution
- `pr_comments` — `installation_id`, `repo`, `pr_number`, `decision_id`, `posted_at` — idempotency + audit
- `jobs` — managed by pg-boss

**Cognee (per installation dataset):** the actual memory graph — repo history + uploaded docs + rules.

## 7. Async pipeline (mandatory — cognify ≫ 10s)
GitHub expects a webhook reply in ~10s; cognify is 100–260s. So:
1. **Webhook receiver (bot):** verify signature → **respond `202` immediately** → enqueue a job keyed by GitHub delivery ID (dedup).
2. **Queue:** **pg-boss** (Postgres-backed, no Redis) on the VM. Job types: `ingest` (backfill/doc) and `catch` (PR opened).
3. **Worker(s):** pull jobs, do the heavy work with retries + backoff (handles LLM rate limits), idempotent by delivery ID / `(repo, pr_number)`.
   - `ingest`: fetch content → LLM-extract decision record → `remember()` into the dataset + upsert `decision_records`.
   - `catch`: run the §9 pipeline → post at most one comment (guarded by `pr_comments`).

## 8. Ingestion (backfill + live)
- **Backfill on install:** the installation token reads the repo's **entire** history (install only gates live webhooks + writes, not historical reads). Paginate via GraphQL; enqueue `ingest` jobs. **Signal-rich selectivity:** prioritize closed/merged PR review threads, `wontfix`/`duplicate`/declined issues, maintainer reasoning; capture the **merged-vs-closed outcome**; skip noise (`+1`) to respect GitHub's 5,000/hr and the LLM budget.
- **Live (forward):** `pull_request`/`issues`/`issue_comment` webhooks stream new decisions into the same dataset; memory compounds.
- **Idempotency:** dedup by issue/PR/comment ID so backfill + webhooks don't double-count.
- **Quality caveat:** it learns from the *text* — only as good as how well maintainers documented their "why."

## 9. Precision / catch logic (verified — mirrors karpathy-wiki)
Cognee's `/search` gives an LLM answer or chunk payloads. **Precision comes from deterministic gates, not a magic score.** On `pull_request.opened`:
1. **Two retrieval passes, separate buckets:** (a) deterministic keyword match of PR signals (deps/paths/labels/nouns) vs `decision_records.terms` (+10 title/+1 body); (b) semantic `CHUNKS`+`verbose:true` search (query = LLM summary of PR intent) → returns **`objects_result[].score`** (cosine, lower=better — live-confirmed) + citation payload (`document_id`, `chunk_id`, `text`).
2. **Grounding gate (false-positive guard):** require ≥2–3 significant-term overlap between the PR and the candidate record's reasoning. Below → suppress. Makes "resembles" quotable.
3. **Outcome + recency filter:** only fire on `rejected` and not `reverted` records (compute from `outcome`/`superseded_by` — Cognee has no built-in supersession resolver).
4. **Judgment LLM (Layer B):** "does this PR resemble candidate X — draft a comment citing its `decision_id`, else no-match." Live-proven: recall correctly **refuses** when no decision matches (no hallucination).
5. **Citation resolution (pre-post gate):** comment must cite a real `decision_id`; use `include_references` Evidence block (doc name + `data_id` + `chunk_id` + quote — live-verified). If it doesn't resolve, **don't post**.
6. **Refuse on weak/empty evidence; one comment per PR** (`pr_comments` marker). Maintainer dismissal → feedback → `memify()` `feedback_influence`.

## 10. User inputs & dashboard (three categories → three destinations)
| Kind | Examples | Destination |
|---|---|---|
| **Knowledge** | style guides, ADRs, CONTRIBUTING, pasted decisions | `remember()` into the dataset |
| **Rules** | "reject PRs re-adding an ORM" | `remember`+`memify()` (`add_rule_associations`, nodeset `coding_agent_rules`); `CODING_RULES` returns the rulebook unranked, the grounding gate + LLM pick the violated rule |
| **Behavior** | tone, watch-paths, threshold, custom instructions, provider | `tenant_config` in our DB, injected at runtime |

Dashboard (Next.js/Vercel): "Login with GitHub" → `GET /user/installations` → connect repos, upload docs, edit rules, pick provider, view graph stats + `visualize()` HTML.

## 11. Feature scope — vertical slice first, then breadth
- **Milestone A (must exist):** one install on your demo repo, end-to-end: backfill ingest → cited recall → live-catch comment → forget. A complete, judge-able demo alone.
- **Milestone B (the product):** multi-tenant (`ENABLE_BACKEND_ACCESS_CONTROL`, dataset per install, `installation.created` auto-provision) + Vercel dashboard (login, doc upload, rules, provider, graph stats).
- **Milestone C (polish/submit):** README (self-hosted, not Cogwit), AI-use disclosure, blog post, backup demo video, VM disk snapshot, a few tests.

## 12. Build sequence (~3 days)
**Day 1 — foundation + de-risk the two unknowns.**
- Provision Azure VM (Ubuntu, B2s) + Docker + Node + pm2 + Cloudflare Tunnel; run `cognee/cognee` (Docker smoke test — production path we substituted with a venv locally); set the **paid** LLM key (Azure OpenAI/DeepSeek/paid Gemini) with pinned models.
- Stand up the bot skeleton (Octokit App) + our DB + pg-boss. **Register the GitHub App**, install on your demo repo, confirm webhook delivery + installation-token auth + a test comment (the deferred GitHub plumbing — do it when ready).
- Seed the demo repo with realistic maintainer decisions.

**Day 2 — Milestone A end-to-end.**
- Backfill worker: fetch history → extract decision records → `remember` + upsert. **Load-test ingestion volume against the paid-tier rate limits.**
- Catch worker: webhook → §9 pipeline → cited comment on the staged PR. Run `memify`. Validate cited recall + the false-positive guard on the seeded repo.

**Day 3 — Milestone B + C.**
- Multi-tenant provisioning + Vercel dashboard (login, upload, rules, provider, graph). `forget` demo moment.
- README + blog + backup video + disk snapshot + rehearse twice. Submit with buffer.

## 13. Demo script (~60–90s)
1. One line + show the graph (`visualize()`).
2. Onboarding question on ingested **Cognee public** data → cited answer.
3. **Centerpiece:** open the staged PR on your demo repo → cited comment appears live.
4. Dashboard: connect a repo, upload a doc, switch LLM provider.
5. `forget()` prune moment.
6. Close: full lifecycle, self-hosted OSS, multi-tenant, bring-your-own-LLM.

## 14. Risks & open items
- [x] EBAC auth, full lifecycle, precision behaviors — **live-verified**.
- [x] Ingestion needs a **paid LLM tier** (free = 20 gen/day) — budget it.
- [ ] Build + load-test the async pipeline against the paid tier's real limits.
- [ ] Retry catch-refinement tests (re-proposal linking, reversal) with a quota'd key.
- [ ] GitHub App registration/webhook/comment — standard, do when touching GitHub.
- [ ] Superseded decisions: compute from `outcome`/`superseded_by` (no Cognee resolver).
- [ ] Snapshot the VM disk before judging (file-based store = single point of loss).
- [ ] Watch the occasional spurious `"Got it."` summary node (non-deterministic; clean ingests are fine).

## 15. Submission checklist
- [ ] README: "Self-hosted Cognee OSS, own LLM/vector/graph config — not Cogwit."
- [ ] AI-assistant usage disclosed.
- [ ] Blog post ("maintainers don't have a documentation problem, they have a memory problem").
- [ ] Backup demo video recorded.
- [ ] All four lifecycle APIs visibly exercised.
- [ ] Submitted with buffer before Jul 5.
