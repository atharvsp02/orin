# Orin — Build Plan
### Cognee Hackathon ("The Hangover Part AI: Where's My Context?") — Open Source Track

---

## 1. Hackathon context

| | |
|---|---|
| Organizer | WeMakeDevs, in partnership with Cognee |
| Dates | Jun 29 – Jul 5, 2026 |
| Prize pool | $10,000 + engineering interview slots at Cognee for top winners |
| Our track | **Best Use of Open Source** — prize: Apple MacBook Neo per team member |
| Other track (not us) | Best Use of Cognee Cloud — iPhone 17, requires Cogwit (Cognee's managed cloud) |
| Side tracks | Best Blogs (Keychron keyboard), Social Buzz (swag), Open Source PR bounty ($100/PR to Cognee's GitHub repo, separate from this project) |
| Judging criteria | Impact · Creativity & Innovation · Technical Excellence · **Best Use of Cognee** · User Experience · Presentation Quality |
| Required tech | Must use Cognee for memory (github.com/topoteretes/cognee) |
| Team | Up to 4 members |
| Disclosure rule | Must declare any AI assistant usage in the submission |

---

## 2. What we're building: Orin

**One-line pitch:** An institutional-memory bot for open-source maintainers — it remembers every past PR rejection and architectural decision, and catches new contributors re-proposing something the project already tried and rejected.

**The problem it solves:**
- Contributors come and go; nobody remembers *why* a tradeoff was made
- Project history is scattered across issues, PR threads, and maintainers' heads
- New contributors repeatedly re-propose ideas that were already tried and rejected
- Maintainers waste huge amounts of time re-explaining the same reasoning in PR reviews

**Flagship demo:** Point Orin at **Cognee's own GitHub repo**, live, in front of the people who built it. Judges watching their own project's memory work is the single most memorable moment we can create.

---

## 3. Track compliance (read this before building anything)

The Open Source track requires **self-hosted Cognee OSS**, not Cogwit (Cognee's managed cloud product).

- **Self-hosted** = we run the open-source `cognee` engine ourselves and control its config (LLM provider, vector store, graph store).
- **Cogwit** = Cognee's own managed service (`cognee.serve(url="https://your-instance.cognee.ai", ...)`) — this is the *other* track.
- Running the open-source Cognee Docker image on Google Cloud Run, Azure, or anywhere else still counts as self-hosted — the cloud provider is just compute. What disqualifies us is calling Cognee's own hosted API.

**Action item:** State this explicitly in the README — *"Self-hosted Cognee OSS, own LLM/vector/graph config — not using Cogwit."* Removes any ambiguity for judges.

---

## 4. Feature scope

### P0 — must work, this is the core demo
1. **Ingest** — pull Cognee's GitHub issues, PRs, and comments; `remember()` them into memory
2. **Recall** — answer a real contributor/onboarding question with a cited past decision
3. **Live catch** — new PR/issue opens on the watched repo → bot checks it against memory → comments if it resembles something already rejected
4. **Improve** — run `improve()`/memify so frequently-cited decisions surface first and stale ones decay
5. **Forget** — live demo of pruning a dataset on request (almost nobody else will show this API — cheap differentiation)
6. **The centerpiece moment** — a staged PR that resembles a documented past rejection, caught and commented on in real time during judging

### P1 — only if P0 is solid with time to spare
7. Multi-tenant onboarding — any user installs the GitHub App on their own repo, gets an auto-isolated dataset
8. Doc upload via a dashboard (style guides, ADRs) into that dataset
9. A small dashboard to browse ingested memory / graph stats

**Rule of thumb:** a rock-solid single-repo P0 demo beats a wobbly multi-tenant P1 demo in judging, every time. Don't start P1 until P0 is fully working end to end.

---

## 5. Cognee lifecycle mapping

| API | What we use it for |
|---|---|
| `remember()` | Ingest GitHub issues, PRs, comments, and maintainer decisions from the target repo |
| `recall()` | Answer onboarding questions with citations; check incoming PRs against memory |
| `improve()` / memify | Reweight frequently-cited decisions, decay stale/superseded ones |
| `forget()` | Prune a dataset on request — live demo moment |

Exercising all four deeply (not just remember+recall) is what the "Best Use of Cognee" judging criterion is actually looking for.

---

## 6. Tech stack

| Piece | Choice | Why / free-tier notes |
|---|---|---|
| Language | TypeScript, `@cognee/cognee-ts` | Official SDK — no Python needed in application code |
| Cognee engine | `cognee/cognee` Docker image on **Google Cloud Run** | Always Free tier: 2M requests/month, 360K GiB-seconds, 180K vCPU-seconds, scales to zero, no expiry |
| Vector + relational store | **Neon** (Postgres + pgvector) | 100 compute-hours/month free, scales to zero after 5 min idle, resumes in ~1s. Native fit for Vercel |
| Graph store | Postgres (same Neon instance) **if `graph_database_provider=postgres` is confirmed supported** — otherwise fall back to **Kuzu** | ⚠️ Must confirm before building further — see Section 8, Open Risks |
| LLM + embeddings | **Groq or Gemini free tier** (primary), **Azure OpenAI** (overflow only) | Free tiers cover hackathon-scale ingestion; Azure credits are a legitimate fallback if free-tier rate limits are hit mid-week |
| Bot / webhook listener | **Vercel** serverless function (Node/TS, Probot or Octokit) | Free tier; same platform as frontend |
| Frontend / dashboard | **Vercel** (Next.js) | P1 only — P0 can demo via PR comments + terminal/logs |
| Data source | GitHub REST/GraphQL API — personal access token (P0) or GitHub App installation token (P1) | Free, 5,000 requests/hour authenticated |
| Multi-tenancy | Cognee's native dataset-level permissions (confirmed on pgvector, Neo4j, Kuzu, LanceDB) | P1 only |

**Total cost: $0**, with Azure OpenAI held in reserve rather than in the critical path.

---

## 7. Architecture notes

**One hosted bot, many possible tenants (P1):** the server itself holds no per-user state. Every GitHub webhook carries an `installation.id`; we look that up in a small mapping table to find the right Cognee dataset, and scope every `remember()`/`recall()` call to that dataset only. Cognee's dataset permissions isolate at the graph/vector level, not just a soft filter, so one tenant can never see another's memory even though they share the same running engine and database.

**Cloud Run statelessness — important:** Cognee's defaults (LanceDB + Kuzu) are file-based and write to local disk, which does not reliably persist across a stateless, scale-to-zero container. This is *why* we're routing storage to external Neon/Postgres rather than using Cognee's local defaults — not a preference, a requirement of the hosting target.

---

## 8. Day-by-day plan (today = Jul 1, submission deadline Jul 5)

| Day | Focus |
|---|---|
| **Jul 1 (today)** | Environment setup: deploy `cognee/cognee` on Cloud Run, wire up Neon, confirm one `remember()` → `recall()` round trip end to end with chosen LLM key. Resolve the graph-store open risk (below) before building further. Pull a small sample of Cognee's issues/PRs via GitHub API just to prove data access works |
| **Jul 2** | Build the real ingestion pipeline — walk Cognee's issues/PRs/comments, `remember()` them into a dataset (a few hundred items — enough for a rich graph without burning through free LLM rate limits). Validate `recall()` gives good cited answers on test questions |
| **Jul 3** | Build the live-catch flow: webhook listener → `recall()` → decide → comment via GitHub API. Test on a scratch repo first. Wire up `improve()` to run post-ingestion |
| **Jul 4** | Polish, add the `forget()` demo moment, write the README (state self-hosted/not-Cogwit clearly) and the required blog post. Start P1 only if there's real time left. Record a backup demo video in case of live network issues on judging day |
| **Jul 5 (submission day)** | Final test pass, rehearse the demo script out loud at least twice, submit with buffer before the deadline |

---

## 9. Demo script (~60–90 seconds)

1. One line on what Orin is; briefly show the ingested graph
2. Ask a real onboarding-style question about Cognee's own codebase → show the cited answer
3. **Centerpiece:** trigger a pre-staged PR resembling a documented past rejection → Orin's comment appears live, citing the exact prior decision
4. Quick `forget()` moment — "and we can prune this on request, which almost nobody demos"
5. Close on the differentiator: full memory lifecycle, self-hosted, reading its own judges' repository right now

---

## 10. Open risks / must-confirm items

- [ ] **Confirm `graph_database_provider=postgres` is actually supported in the current Cognee release.** If not, fall back to Kuzu for the graph layer specifically, which will need a persistent volume mount on Cloud Run rather than relying on local ephemeral disk.
- [ ] Watch free-tier LLM rate limits (Groq/Gemini) during the full ingestion run in Step Jul 2 — budget the item count accordingly, switch to Azure OpenAI overflow if throttled.
- [ ] Don't start P1 (multi-tenancy, doc upload, dashboard) until P0 is fully working end to end on the real target repo.

---

## 11. Submission checklist

- [ ] README states clearly: self-hosted Cognee OSS, not Cogwit
- [ ] AI assistant usage disclosed per hackathon rule 8
- [ ] Required blog post written (framing: "maintainers don't have a documentation problem, they have a memory problem")
- [ ] Demo video recorded as backup
- [ ] All four lifecycle APIs (`remember`, `recall`, `improve`, `forget`) visibly exercised in the demo
- [ ] Submitted with buffer before the Jul 5 deadline
