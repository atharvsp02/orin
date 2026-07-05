# Orin — Scaling Roadmap & Feature Research

_Synthesis of four research streams (GitHub-native features, untapped Cognee capabilities, cross-platform integrations, market/positioning), Jul 2026. Sources at the bottom of each part._

## The one-line reframe (this should drive every feature choice)

Every competitor — Unblocked, Glean, Cody/Sourcegraph, CodeRabbit, Greptile, Graphite — does **positive retrieval**: "how does X work / where is it / summarize this PR." **Orin is the only one doing negative/decision memory + proactive enforcement**: *"we already considered this and said no — here's why."* That white space is the wedge. Its two current weaknesses are **delivery** (a single issue comment) and **timing** (only fires after a PR opens). Fix those, deepen the Cognee lifecycle, then expand off GitHub.

---

## Part 1 — Make it a better GitHub bot (Cognee-aware)

### 1A. Table-stakes — ship these or a differentiated engine still feels like a toy (all quick)
| Feature | Effort | Why |
|---|---|---|
| **Decision-conflict Check Run (status gate)** | M | Publish a `Orin / decision-conflict` **check run** instead of a comment; teams make it a **required status check** so a re-proposed rejection *blocks merge*. Converts a passive comment into governance. Highest-leverage single change. |
| **Inline PR review anchored to the hunk** | S–M | A formal review comment on the exact lines re-introducing the rejected decision + a permalink to the prior PR/issue + (where implied) a suggested-change block. A bare issue comment reads as low-signal by 2026 norms. |
| **Fire on draft / `ready_for_review` / `synchronize`** | S | Run the catch on **draft** PRs so contributors see the conflict *before* asking for review. Same pipeline, just new webhook filters. Closes the "only after open" gap. |
| **Rich presentation** (verdict + severity + collapsible evidence) | S | Show the cited prior decision, the deterministic term hits, and the semantic score. Pure rendering — the pipeline already produces all of it. Matches CodeRabbit's explainability bar. |

### 1B. Differentiated moat — nobody else models decision *outcomes*
| Feature | Effort | Why |
|---|---|---|
| **`/orin override "<reason>"` → supersede** | M | A maintainer consciously reversing a past "no" mints a **new accepted decision that supersedes the rejection** (outcome flips, `supersedes` edge added). The highest-value signal you can capture; the killer human-in-the-loop loop. |
| **Catch re-proposals at the *issue* stage** | S–M | On `issues.opened`, recall against rejected decisions → "considered and rejected in #X because…" Stops a dead-end before any code is written. Generic triage bots dedupe issues; none triage against a rejected-decision graph. |
| **Contributor pre-flight** (CLI + reusable Action + pre-commit) | M–L | Query the repo's memory with a staged diff *before* opening a PR. Flips "gotcha bot" → "save yourself the round-trip." Shift-left, and extends the moat off-platform. |
| **Revert-aware ingest** | M | On a revert commit/PR, flip the decision's outcome to `reverted` and notify any *open* PR that relied on it. Closes a loop the research literature flags as unsolved. |
| **Decision-authorship reviewer routing** | M | Request the *original decision author* as reviewer (decision→author edges), complementing CODEOWNERS (which only routes by file ownership). |
| **Living Decision Log** (Discussions or auto-`docs/decisions/*.md`) | M | Publish extracted decision records as a browsable, auditable artifact — "ADRs that write themselves." Gives catch comments a canonical link target. |
| **Feedback loop** (👎 / "not a match" reply mutates memory) | M | Down-weights false-positive recalls, up-weights confirmed ones — see improve() below. |

### 1C. "Best Use of Cognee" depth — the judging lever (verified against cognee 1.2.2 source)
| Capability | Orin feature | Effort | Verified caveat |
|---|---|---|---|
| **CODING_RULES + `add_rule_associations`** | Mine durable, **deduped** maintainer rules from repeated rejections (3+ rejected PRs touching `orm/prisma` → a candidate rule), each with provenance edges to the origin thread. Closest thing to the product's literal job; a worked example ships in Cognee. | M | Retrieval-only — returns raw rule strings; *we* enforce the comparison. |
| **`improve()`/memify + feedback weighting** | Maintainer 👍/👎 on a verdict reweights the exact decision nodes/edges (EMA, `w += 0.1*(rating−w)`) → recall surfaces battle-tested decisions first. **Completes remember→recall→improve→forget** = the lifecycle judges reward. | M | **Off by default:** requires `DEFAULT_FEEDBACK_INFLUENCE > 0` AND recall run with a `session_id` (so `used_graph_element_ids` is recorded). Wire both or weights are computed-but-ignored. |
| **`GRAPH_COMPLETION_COT`** | Multi-step reasoning for "is this PR re-proposing something already rejected, even if worded differently?" | S | Just a `query_type` swap — recommended for the catch path. |
| **TEMPORAL** | "What was decided about X *as of* March 2024?" / decision timeline. | S–M | **No built-in decay/staleness/superseded** — pure time-range filter. Model supersession yourself (ontology/edges). |
| **Ontology** (per-repo `.owl`) | Classes Decision/Rejection/Rule/Component/Reviewer + relations `supersedes`/`applies_to`/`rejected_because`. Higher-precision, consistent extraction; the correct home for supersession. | M | Config/env only — zero code to wire. |
| **Dataset sharing / permissions** | Org-level shared "global rejected-decisions" dataset + per-repo private ones; a new repo inherits org memory; cross-repo recall. | L–M | Multi-tenant machinery already exists; add `share` calls + multi-`dataset_ids` recall. |
| **`visualize()`** | Graph/timeline HTML (with a session-events timeline: searches as spotlights, rated answers as reinforcement) for the dashboard + a killer demo artifact. | S | — |
| **AGENTIC_COMPLETION + skills/tools** (stretch) | Multi-step ReAct triage agent that calls tools ("fetch diff", "search rejections", "check rules") and learns via skill success scores. | L | Skills/tools hard-gated to this search type; must register tools/skills per dataset. |

---

## Part 2 — Beyond GitHub (platform expansion)

**Architecture:** build **one shared Cognee "decision core"** (ingest + query + citation), then thin per-platform adapters exposing three primitives: **ask** ("has this been decided?"), **ingest** (pull decision threads in), **warn** (a new proposal matches a past rejection). Cognee already ships an **MCP server** (`cognee-mcp`), a REST API, and SDKs — so this is adapters, not new memory.

### Priority order (impact-per-effort)
1. **MCP server — do this first.** [S–M] Cognee already ships `cognee-mcp`; expose decision-specific tools (`ask_decision`, `check_rejected`, `record_decision`). One build reaches **every IDE agent** — Cursor, Claude Code, VS Code Copilot, Windsurf, ChatGPT — via the same spec. Puts decision memory in the editor at the moment of coding. Local stdio for design partners → remote HTTP + OAuth 2.1 for org rollout.
2. **Slack.** [M] Where decisions are *argued*. `/why did we choose Postgres?` → cited answer (defer within Slack's 3s ack, post async via Bolt); emoji-to-capture ingest (react `:decision:` → file it); rejection-collision warnings. Do the well-trodden slash-command path first; the native Assistant/Agents surface + Marketplace is partner-gated for now.
3. **Linear.** [M] Where decisions are *recorded* (issues ≈ decisions → clean ingest). New Agent Interaction SDK makes Orin an @-mentionable actor (`actor=app`) that warns when a new issue repeats a rejection. (Agent APIs still Developer Preview — fast-follow.) **Notion** is the runner-up if the team's ADRs already live there (better canonical store, weaker live surface).
4. **CLI.** [S] Cheap freebie over the same core; unlocks a **CI decision-gate** (fail/warn a PR whose description matches a rejection).
5. **Email ingest.** [S–M] `decisions@` forwarding + reply-by-email via inbound-parse webhooks — good passive capture, noisy for Q&A.

**Defer / low-value:** MS Teams (heavy Azure setup; only for MS-shop enterprises — ride the M365 Agents SDK's native MCP when you do), Jira (Rovo remote agents are EAP, need A2A+JWKS), WhatsApp (business verification + template approval + per-message billing + 24h window; wrong context for eng decisions), Telegram/Discord (niche — Discord genuinely useful for **OSS communities / DAO governance memory**).

---

## Part 3 — Strategic frame (why this scales)

- **Market is validated + funded but positive-retrieval only:** Glean ($7.2B val, ~$300M ARR), Unblocked ($20M A, "decision-grade context"), Dust ($40M B), Cognee ($7.5M seed), Mem0 ($24M). Demand signal: Atlassian 2025 — 40% of devs cite "finding context" as their #1 drain; 49% re-answer the same questions.
- **Differentiation:** negative decision memory + proactive PR-time enforcement, **graph-native** (typed edges: proposal→rejected-by→reason→superseded-by; memify/forget so reverted decisions decay), **OSS + self-hosted** (counters the cost + "don't send our code to SaaS" objections). ADR automation is the on-ramp category — "Adopt"-rated since 2017 yet still manual markdown.
- **Moat = the compounding per-org decision graph** — it literally can't be back-filled by a competitor who starts three months later. The defensible asset is the dataset + enforcement workflow, *not* the Cognee tech (which is OSS anyone can use).
- **Expansion:** repo (free OSS, bootstrapped from git history) → org (paid: SSO, rollups, analytics) → multi-platform (Slack/docs — the Glean-sized TAM, but decision-native). **GTM:** open-core PLG; hosted Cloud ~$20–35/seat or per-repo; enterprise (SSO/RBAC/BYOC/audit).
- **Top 3 risks:** (1) **incumbent bolt-on** — GitHub/Glean/Unblocked could add "we rejected this before"; defend with the per-org dataset + workflow. (2) **Cold-start / empty graph** — value compounds over months; *we already backfill history on install*, which is the exact mitigation — keep it strong. (3) **False-positive / trust blowup** — an over-eager PR bot is a reputational liability (cf. the Feb 2026 matplotlib "AI-shaming" incident); the grounding gate + refuse-on-weak-evidence + human override are the defense. Precision is existential.

---

## Part 4 — Verdict on the 10 ideas you were given

All 10 are solid and map to validated research; here's the read plus what they miss.

| # | Idea | Verdict | Maps to |
|---|---|---|---|
| 1 | Pre-flight check | ✅ strong | 1B contributor pre-flight |
| 2 | Auto-supersession detection | ✅ good (but Cognee won't do it for you — model edges/ontology) | 1B revert-aware + 1C ontology |
| 3 | Rule mining from rejections | ✅✅ highest Cognee leverage (native support) | 1C CODING_RULES |
| 4 | ADR auto-draft on merge | ✅ strong (on-ramp category) | 1B living decision log |
| 5 | "PRs prevented" metric | ✅ cheap, best 10-second pitch number | dashboard |
| 6 | Evidence trail view | ✅ makes "we don't hallucinate" visual | 1A presentation + visualize() |
| 7 | Decision graph timeline | ✅ | 1C visualize() + TEMPORAL |
| 8 | Staleness/confidence decay | ✅ but **implement in *your* scoring** — TEMPORAL has no built-in decay | 1C caveat |
| 9 | Audit log + maintainer override | ✅✅ the override→supersede is the killer loop | 1B override + 1C improve()/feedback |
| 10 | Rate-limit-aware backfill scheduler | ✅ addresses the confirmed 20-gen/day wall + cold-start | ops |

**What the 10 miss (add these):** the **Check Run status gate** (block merge — highest leverage), **inline PR review** (vs issue comment), **issue-stage catch** (before code), the **MCP server** (biggest reach-per-effort of anything here), **Slack** (where decisions are argued), and using **`CODING_RULES` + `improve()` natively** to complete the Cognee lifecycle.

---

## Part 5 — Recommended sequencing

**For the hackathon (next few days — maximize the judging criteria):**
1. **`improve()`/feedback weighting** + **`forget()` wired to an event** → visibly exercises **all four lifecycle APIs** (Best Use of Cognee). Mind the feedback wiring caveats.
2. **CODING_RULES rule-mining** from the seeded rejections (Cognee-native, worked example).
3. **Check Run gate** + **evidence panel** + **"PRs prevented" metric** + **`visualize()` graph** → UX + Presentation.
4. Swap the catch recall to **`GRAPH_COMPLETION_COT`** (one-line, better matches).

**Product v1 (immediately after):** MCP server, inline PR review, issue-stage catch, contributor pre-flight, revert-awareness, per-repo ontology.

**Scaling v2+:** Slack, org-wide shared memory (dataset sharing), Linear, dashboard + analytics, cloud/monetization.

---

## Sources (condensed — full lists in the research streams)
- GitHub bots: CodeRabbit Learnings, Greptile graph context, Graphite Reviewer, Qodo Rules System, Baz Custom Reviewers, Devin Review; GitHub Checks API / required status checks / PR reviews API.
- Cognee source (1.2.2, `inspiration/cognee`): `SearchType.py`, `coding_rule_associations.py`, `improve.py`, `apply_feedback_weights.py` + `CogneeGraph.py:470-540`, `temporal_retriever.py`, `agentic_retriever.py`, permissions methods, `visualize.py`, `references.py`.
- Platforms: MCP servers/registry, Cognee `cognee-mcp`, Slack Bolt/Assistant API, Linear Agent Interaction SDK, Jira Forge/Rovo (EAP), Notion Dev Platform, VS Code Chat/Tool/MCP APIs, WhatsApp Cloud API pricing.
- Market: Glean $7.2B (Series F), Unblocked $20M, Dust $40M, Cognee $7.5M; Atlassian/Skan developer-context surveys; ThoughtWorks ADR "Adopt"; matplotlib PR-bot trust incident.
