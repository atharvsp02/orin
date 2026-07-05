# Orin: 3-minute hackathon demo (cut sheet + VO + Remotion cards)

Target: 180s hard cap. One money shot (the failing check with a citation) at the center,
everything else feeds it. Screen recordings + Remotion text cards between cuts. Talk at a calm
pace (~140 wpm); every VO line below is sized to its slot.

---

## Cut sheet

### 0:00 - 0:12 | COLD OPEN (Remotion card, no screen)
- Black `#09090B`, Orin mark, two lines fade in:
  - "Every rejected idea comes back."
  - "Six months later. From someone new."
- VO: "Every engineering team rejects ideas for good reasons. Then the person who knew the
  reason leaves, and six months later the same PR shows up again."

### 0:12 - 0:24 | LANDING (screen: slow scroll of homepage hero)
- Record: orin homepage, hero + 3D dashboard tilt, slow scroll to logo cloud.
- Remotion lower-third: "Orin: institutional memory for engineering teams"
- VO: "Orin is institutional memory for your team. It remembers every decision and catches the
  ones you're about to repeat. This is it, end to end, live."

### 0:24 - 0:48 | TEACH IT (screen: GitHub issue flow, tight cuts)
- Record: demo repo → issue "Add Redis as a caching layer" → maintainer comment:
  "Rejected: extra service to operate, ops burden; Postgres materialized views already cover
  caching." → close issue.
- Remotion micro-card (1s, between cuts): "closed threads become memory"
- Jump-cut card (1.5s): "~a minute later" (covers cognify latency)
- Record: dashboard → Decisions → ISSUE-N appears, REJECTED badge, reasoning visible.
- VO: "You don't configure anything. A maintainer rejects an idea like they always do, with
  reasoning, and closes the thread. A minute later it's a decision in Orin's knowledge graph:
  outcome, reasoning, and the receipts."

### 0:48 - 1:22 | THE CATCH (screen: the money shot, give it air)
- Record: new branch PR "add redis cache" opens → checks pending → **Orin check FAILS** →
  click Details: "Re-proposes ISSUE-N (rejected)" + reasoning + evidence.
- Remotion: red highlight ring/zoom on the check line, then on the citation text.
- Remotion lower-third: "merge blocked. decision cited."
- VO: "Two weeks later someone new proposes Redis again. Orin checks the PR against memory,
  and fails the required check, with the citation. Not 'looks risky.' The actual decision,
  the actual reasoning, the actual thread. The merge is blocked before the debate restarts."

### 1:22 - 1:42 | THE HUMAN LOOP (screen: PR comments)
- Record: comment `@orin override ISSUE-N "we have a dedicated infra team now"` → Orin reply:
  recorded OVERRIDE, superseding ISSUE-N → `@orin re-scan` → check turns green.
- Remotion micro-card: "memory is governable, not a cage"
- VO: "And when the context genuinely changes, one comment overrides it, with receipts. The
  old decision isn't deleted; it's superseded. The check goes green."

### 1:42 - 2:00 | SLACK (screen: Slack workspace)
- Record: `/why did we reject redis` → cited answer with the Evidence chunk visible.
- Optional second beat (3s): 🧠 reaction on a message + caption "reactions record decisions".
- Remotion lower-third: "same memory, where the debate actually happens"
- VO: "The same memory answers everywhere your team argues. In Slack, slash-why returns the
  decision with evidence, linked to this org's GitHub memory by a one-time admin code."

### 2:00 - 2:14 | AGENTS / MCP (screen: pick ONE)
- Option A (best): Cursor/Claude Code calling `check_rejected` on a change → tool result flags
  ISSUE-N before a PR exists.
- Option B (fallback): dashboard Integrations → the syntax-colored MCP config + terminal
  running the CLI pre-flight exiting non-zero.
- Remotion lower-third: "your AI agents ask before repeating history"
- VO: "Your coding agents plug in over MCP. Cursor or Claude Code can check a change against
  memory before the PR even exists, and CI can gate on it."

### 2:14 - 2:36 | DASHBOARD SWEEP (screen: fast pans, 4-5s each)
- Record: Catches (stat tiles + catch detail) → Knowledge graph (drag the real Cognee graph) →
  Rules (org/repo scope selector) → Docs (upload an ADR, 'Teach Orin').
- Remotion micro-captions per pane: "catches" / "the graph itself" / "rules, org or per repo" /
  "teach it your docs"
- VO: "Everything is observable: every catch with its citation, the knowledge graph itself,
  standing rules scoped org-wide or per repo, and docs, ADRs, postmortems, uploaded straight
  into memory."

### 2:36 - 2:52 | BUILT ON COGNEE (Remotion diagram card)
- Animated four-verb loop: remember → recall → improve → forget, with small captions:
  - remember: decisions, docs, rules (ontology-grounded)
  - recall: GRAPH_COMPLETION_COT with sessions
  - improve: maintainer good/bad reweights nodes hourly
  - forget: uninstall prunes the tenant
- Footer line on card: "self-hosted Cognee 1.2.2 · EBAC multi-tenant · DeepSeek + local embeddings"
- VO: "Under the hood this is Cognee's full lifecycle, live: remember, recall with sessions,
  improve, maintainer feedback literally reweights the graph, and forget on uninstall. One
  isolated tenant per org, self-hosted."

### 2:52 - 3:00 | CLOSE (Remotion card)
- Orin mark + "Remember the past. Ship the future."
- `github.com/apps/orinbot` · `orin-bot.duckdns.org`
- VO: "Orin. Remember the past, ship the future."

---

## Remotion asset list
1. Cold-open card (2 lines, staggered fade, 12s)
2. Lower-third component (small caps, zinc-400, thin left border) used ~5 times
3. Micro jump-cut card ("~a minute later", "memory is governable...") 1-1.5s each
4. Highlight ring/zoom for the failing check + citation (scale 1.05 + red ring)
5. Four-verb lifecycle diagram card (16s, animated arrows)
6. Close card (8s)
- All on `#09090B`, Geist, same zinc palette as the product. No stock music spikes; low bed,
  duck under VO.

## Pre-record checklist (do BEFORE recording, in order)
1. Create a fresh demo repo (e.g. `acme-api`), install OrinBot on it, enable branch protection
   requiring the "Orin" check (that's what makes the red check BLOCK the merge visibly).
2. Dry-run the ingest once off-camera (open/close a throwaway rejection) to warm everything.
3. Record TEACH and CATCH in real time, then cut the waits; keep raw footage as proof.
4. Slack: workspace already linked to the org memory (one-time code flow) BEFORE recording;
   test `/why did we reject redis` once off-camera.
5. Dashboard at 100% zoom, 1600px+ window, no bookmarks bar, dark OS theme.
6. Backup plan: full-res screenshots of every beat in case a live take flakes.
7. Keep total VO under ~420 words (this script is ~400).

## What is deliberately NOT in the 3 minutes
Linear agent, CLI details, key minting, settings, self-serve multi-tenancy mechanics, security
hardening. One caption ("every install is an isolated tenant") carries the weight; the README
covers the rest for judges who dig.
