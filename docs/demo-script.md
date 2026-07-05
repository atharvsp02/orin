# Orin: 3-minute hackathon demo (cut sheet + VO + Remotion)

Target 180s hard cap. Structure is three acts around ONE narrative: a single Redis decision,
recorded once, then catching / answering / warning / gating across GitHub, Slack, Linear, and
Cursor. That "one memory, every surface" payoff is the wedge over single-platform review bots.

Every beat is marked:
- 🎙️ VOICE  = you talk over it (calm, ~140 wpm)
- 🔇 SILENT = Remotion text + on-screen action + music bed only, no talking (deliberate rhythm)

Voiced word budget ≈ 300 words total (only the 🎙️ beats). Keep music low, duck under VO.

---

## ACT 1 - The problem, and how memory forms (0:00 - 0:46)

### 0:00 - 0:10 | Cold open  🎙️ (Remotion card, no screen)
- Black `#09090B`, Orin mark; two lines stagger in: "Every rejected idea comes back." /
  "Months later. From someone new."
- VO: "Teams reject ideas for good reasons. Then the person who knew the reason moves on, and
  months later the same proposal comes back."

### 0:10 - 0:22 | Landing  🎙️ (screen: slow hero scroll)
- Remotion lower-third: "Orin: institutional memory for engineering teams"
- VO: "Orin remembers your team's decisions and catches the ones you're about to repeat.
  Not just on GitHub, everywhere your team works. Here it is, live."

### 0:22 - 0:46 | Teach it once  🎙️ (screen: GitHub issue → dashboard)
- Record: issue "Add Redis as a caching layer" → maintainer rejection comment with reasoning
  → close. Remotion jump-card (1.5s): "~a minute later". Cut to dashboard → Decisions →
  ISSUE-N, REJECTED, reasoning visible.
- VO: "No setup. A maintainer rejects an idea the way they always do, with reasoning, and
  closes the thread. A minute later it's a decision in Orin's knowledge graph. Remember that
  Redis rejection; we only record it once."

---

## ACT 2 - One decision, every surface (0:46 - 2:02)

### 0:46 - 0:54 | Act card  🔇 (Remotion, full screen)
- Big: "One decision." → "Every surface." Four small logos animate in: GitHub, Slack, Linear,
  Cursor. Music lifts here.

### 0:54 - 1:22 | GitHub: the catch  🎙️ (screen: THE money shot, give it air)
- Record: new PR "add redis cache" → checks pending → **Orin check FAILS** → Details:
  "Re-proposes ISSUE-N (rejected)" + reasoning + evidence. Remotion red ring/zoom on the
  citation. Lower-third: "merge blocked · decision cited".
- VO: "Weeks later, someone new opens exactly that PR. Orin fails the required check with the
  citation, the real decision and reasoning, and the merge is blocked before the debate even
  restarts. That's the moment. Now watch the same memory show up everywhere else."

### 1:22 - 1:38 | Slack  🔇 (screen: Slack, captions only)
- Record: `/why did we reject redis` → cited answer with the Evidence chunk. (Optional 3s: 🧠
  reaction on a message.)
- Remotion captions timed to the action: "in Slack: /why" → "same decision, with evidence" →
  "linked to GitHub memory by a one-time admin code". No VO; let it read.

### 1:38 - 1:54 | Linear  🔇 (screen: Linear, captions only)
- Record: create an issue proposing Redis → Orin comments a collision warning citing the same
  decision; or @mention Orin in an issue → agent replies with the cited decision.
- REQUIRES: Linear linked to the GitHub org memory first (`@Orin link` in Linear → `@orin link
  CODE` on GitHub). Standalone Linear has its own empty memory and will NOT show the Redis
  decision. See checklist.
- Remotion captions: "in Linear: @Orin, or on issue-create" → "same memory, warns before the
  work starts". No VO.

### 1:54 - 2:02 | Cursor / MCP  🎙️ (screen: IDE)
- Record: Cursor / Claude Code calling `check_rejected` on a change → tool result flags
  ISSUE-N, before any PR exists. (Fallback: CLI pre-flight exiting non-zero in a terminal.)
- VO: "And your coding agents ask Orin over MCP, catching it before a pull request even exists."

---

## ACT 3 - Governable, observable, and the engine (2:02 - 3:00)

### 2:02 - 2:16 | Human loop / override  🔇 (screen: GitHub PR, captions)
- Record: `@orin override ISSUE-N "we have a dedicated infra team now"` → Orin records an
  OVERRIDE superseding ISSUE-N → `@orin re-scan` → check turns green.
- Remotion captions: "context changed?" → "@orin override, with receipts" → "superseded, not
  deleted" → check flips green. No VO.

### 2:16 - 2:38 | Dashboard sweep  🔇 (screen: fast pans, music-driven)
- Record: Catches (stat tiles + a catch detail) → Knowledge graph (drag the live Cognee graph)
  → Rules (org/repo scope selector) → Docs (upload an ADR, "Teach Orin").
- Remotion micro-captions per pane: "every catch, cited" / "the graph itself" / "rules, org or
  per-repo" / "teach it your ADRs". No VO; punchy cuts on the beat.

### 2:38 - 2:54 | Built on Cognee  🎙️ (Remotion diagram card)
- Animated four-verb loop: remember → recall → improve → forget. Footer: "self-hosted Cognee
  1.2.2 · EBAC multi-tenant · DeepSeek + local embeddings · one isolated tenant per org".
- VO: "Under the hood it's Cognee's full lifecycle, live. It remembers, recalls with sessions,
  and maintainer feedback literally reweights the graph over time. Every workspace is its own
  isolated tenant."

### 2:54 - 3:00 | Close  🎙️ (Remotion card)
- Orin mark + "Remember the past. Ship the future." + `github.com/apps/orinbot`.
- VO: "Orin. Remember the past, ship the future."

---

## Surface balance (so it's not "a GitHub bot")
GitHub ~50s, Slack ~16s, Linear ~16s, MCP/Cursor ~8s, dashboard ~22s. The act-2 card frames all
four as equals; GitHub keeps the single deep explained catch, the others land fast as the
"everywhere" montage.

## Remotion assets
1. Cold-open card (2 lines, 10s)
2. Lower-third component (small caps, zinc-400, thin left border) - reused
3. Jump/act cards: "~a minute later", "One decision. / Every surface." (+ 4 logos)
4. Highlight ring + zoom for the failing check + citation
5. Timed caption tracks for the 🔇 Slack / Linear / override / dashboard beats
6. Four-verb lifecycle diagram (16s)
7. Close card (6s)
- All `#09090B`, Geist, product zinc palette.

## Pre-record checklist (in order)
1. Fresh demo repo; install OrinBot; **enable branch protection requiring the "Orin" check**
   (this is what makes the red check visibly BLOCK the merge).
2. Slack workspace pre-linked to the org memory BEFORE recording: `/orin link` in Slack →
   `@orin link CODE` on a GitHub issue. Test `/why did we reject redis` off-camera.
3. Linear org authorized AND linked to the same org memory: `@Orin link` in a Linear issue →
   `@orin link CODE` on GitHub. Without this, Linear's memory is empty and the beat fails.
   Test the @mention / issue-create warning off-camera after linking.
4. Cursor/Claude Code MCP configured with a minted repo key; test `check_rejected` once.
5. Warm the pipeline: run one throwaway ingest so cognify caches are hot.
6. Record teach + catch in real time; cut the waits with the "~a minute later" card; keep raw
   footage as proof of a live run.
7. Dashboard at 100% zoom (already scaled to 110% internally), 1600px+, dark OS theme, no
   bookmarks bar. Screenshot every beat as a fallback.

## Deliberately cut
Key minting UI, settings, self-serve multi-tenancy mechanics, security hardening. One caption
("one isolated tenant per org") carries it; the README covers the rest for judges who dig.
