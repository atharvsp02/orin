# Orin: 3-minute demo shot list (read-and-record)

How to read this:
- 🎙️ YOU TALK  = you screen-record this and speak the **SAY** lines word for word.
- 🔇 NO TALK    = no voice. Just screen action + text on screen + music. I build the text in Remotion.
- "VO" is gone; it only ever meant voiceover (you talking). Ignore that word anywhere.

Rhythm you asked for: music+text intro (silent) → you talk → text card (silent) → demo you talk →
text → demo you talk … it alternates the whole way. Total ~176s, under the 180s cap.

You record the 🎙️ cuts and the raw screen for the 🔇 cuts, and send me the clips in order.
I assemble + add all text cards, highlights, and music.

---

## Demo data (use these EXACT values everywhere; keeps it consistent on screen and in your voice)

- Repo name: **`payments-api`** (under your demo account, e.g. `your-org/payments-api`)
- The decision topic: **Redis caching** (universal, everyone gets it)
- Issue title: **Add Redis as a caching layer**
- Issue body: "We're seeing slow response times on the analytics endpoints. Proposing we add
  Redis as a caching layer in front of Postgres."
- Maintainer's rejection comment (paste this as the reason, then close the issue):
  "Rejecting this. Redis is another service to run and monitor, and it adds a cache-invalidation
  problem we don't want. Our Postgres materialized views already cover these queries. Let's
  revisit only if materialized-view refresh time becomes the bottleneck."
- The re-proposing PR title: **Add Redis caching for API responses**
- PR body: "Adds a Redis cache in front of the analytics endpoints to speed up response times."
- Slack question: **`/why did we say no to redis`**
- Linear issue title: **Introduce Redis caching for analytics**
- Override comment (on the failed PR): **`@orin override ISSUE-1 "we now have a platform team to operate Redis"`**
  (use whatever the real issue number is, e.g. ISSUE-1)

---

## THE CUTS

### CUT 1: Brand intro  🔇 NO TALK  (~6s)
- Screen: none (I build it). Black `#09090B`, Orin mark fades in, tagline under it, soft music rising.
- Text on screen: **Orin** / small under it: **institutional memory for engineering teams**
- Who makes it: I build in Remotion. You do nothing.

### CUT 2: The hook  🎙️ YOU TALK  (~15s)
- Screen: slow scroll down the Orin homepage (hero + the tilted dashboard). Record ~15s of calm scroll.
- SAY (word for word):
  "Every engineering team rejects ideas for good reasons. Then the people who remember those
  reasons move on. Months later the same idea comes back, and nobody remembers why you said no.
  Orin is the memory that does."

### CUT 3: Transition card  🔇 NO TALK  (~4s)
- Screen: none (I build it).
- Text on screen: **First, teach it a decision.**

### CUT 4: Teach it  🎙️ YOU TALK  (~20s)
- Screen: GitHub `your-org/payments-api` → open the issue "Add Redis as a caching layer" → show
  the maintainer's rejection comment → click Close. Record the whole thing.
- SAY:
  "Here's a real repo. Someone proposes adding Redis as a caching layer. A maintainer says no:
  it's another service to run, and Postgres materialized views already cover it. They close the
  issue. No special syntax, nothing. Orin just read that decision into its memory."

### CUT 5: Time jump  🔇 NO TALK  (~2s)
- Screen: none.
- Text on screen: **~a minute later**

### CUT 6: Decision recorded  🎙️ YOU TALK  (~10s)
- Screen: Orin dashboard → Decisions → the Redis decision showing REJECTED with the reasoning. Record it.
- SAY:
  "And there it is in the dashboard. The decision, the reasoning, marked rejected. Remember this,
  because we only recorded it once."

### CUT 7: Act card  🔇 NO TALK  (~5s, music lifts)
- Screen: none (I build it).
- Text on screen: **One decision.** then **Every surface.** with four logos appearing:
  GitHub, Slack, Linear, Cursor.

### CUT 8: THE CATCH (the big one)  🎙️ YOU TALK  (~26s)
- Screen: GitHub `payments-api` → a new PR "Add Redis caching for API responses" → the checks run
  → **Orin's check FAILS (red)** → click "Details" → show the citation (re-proposes ISSUE-1,
  rejected, with the reasoning). Give this room; let the red check sit on screen.
- SAY:
  "Weeks later, someone new opens exactly that pull request. Adds Redis. And Orin fails the check,
  before anyone wastes time reviewing it. Not 'this looks risky.' It cites the exact past decision,
  the reasoning, and links the original thread. The merge is blocked until a human decides. That's
  the whole product, right there."

### CUT 9: Slack  🔇 NO TALK  (~14s)
- Screen: Slack → type `/why did we say no to redis` → Orin's cited answer appears. Record it.
- Text on screen (I add): **In Slack: /why** then **Same decision. With evidence.**
- NOTE: Slack must be linked to this repo's org memory BEFORE recording (see checklist).

### CUT 10: Linear  🔇 NO TALK  (~14s)
- Screen: Linear → create an issue "Introduce Redis caching for analytics" → Orin comments a
  collision warning citing the same decision. Record it.
- Text on screen (I add): **In Linear** then **It warns before the work even starts.**
- NOTE: Linear must be linked to the same org memory BEFORE recording (see checklist).

### CUT 11: Coding agents / Cursor  🎙️ YOU TALK  (~12s)
- Screen: Cursor or Claude Code with Orin's MCP configured → ask it to check a change → it calls
  `check_rejected` and flags the Redis decision. Record it. (Fallback: a terminal running the
  CLI pre-flight and exiting with an error.)
- SAY:
  "And your AI coding agents plug in over MCP. Cursor checks a change against the same memory
  before a pull request even exists. Same decision, everywhere your team works."

### CUT 12: Override  🔇 NO TALK  (~12s)
- Screen: on the failed PR, comment `@orin override ISSUE-1 "we now have a platform team to operate
  Redis"` → Orin replies it recorded an override → comment `@orin re-scan` → the check turns green.
  Record the whole flow.
- Text on screen (I add): **Context changed? Override it. With receipts.** then **Superseded, not deleted.**

### CUT 13: Dashboard tour  🔇 NO TALK  (~18s, music-driven)
- Screen: quick pans, ~4s each: Catches (the stat tiles + a catch) → Knowledge graph (drag the
  live graph around) → Rules (open the org / repo scope dropdown) → Docs (upload a file, hit
  "Teach Orin"). Record each.
- Text on screen (I add, one per pane): **Every catch, cited** / **The graph itself** /
  **Rules, org or per repo** / **Teach it your docs**

### CUT 14: Built on Cognee  🎙️ YOU TALK  (~14s)
- Screen: none needed (I build a four-verb loop animation: remember → recall → improve → forget).
  If you want, screen-record the knowledge graph again as backup B-roll.
- SAY:
  "Under the hood this is Cognee's full memory lifecycle, running live. It remembers decisions,
  recalls them with reasoning, and when a maintainer says good catch or bad catch, it actually
  reweights the graph. Every workspace is its own private memory."

### CUT 15: Close  🎙️ YOU TALK (short)  (~5s)
- Screen: none (I build it). Orin mark + tagline + install link.
- Text on screen (I add): **Orin. Remember the past. Ship the future.** / `github.com/apps/orinbot`
- SAY (short, optional): "Orin. Remember the past, ship the future."

---

## What I build vs what you record
- I build (no recording needed): CUT 1, 3, 5, 7, 15 text/brand cards, the CUT 14 lifecycle
  animation, and ALL the on-screen text/highlights/music on top of your clips.
- You record (screen, some with your voice): CUT 2, 4, 6, 8, 11, 14 (you talk) and CUT 9, 10, 12,
  13 (screen only, no voice).

## Before you record (do these in order, or beats will show empty memory)
1. Fresh repo `your-org/payments-api`; install OrinBot on it; turn ON branch protection that
   REQUIRES the "Orin" check (that's what makes the red check actually block the merge in CUT 8).
2. Do the Redis issue once off-camera first so the pipeline is warm, then do it again on camera.
3. Slack: link it to the org memory before CUT 9: run `/orin link` in Slack, then comment
   `@orin link CODE` on any issue in the repo. Test `/why did we say no to redis` off-camera.
4. Linear: link it too before CUT 10: in a Linear issue type `@Orin link`, then comment
   `@orin link CODE` on GitHub. Test the warning off-camera.
5. Cursor/Claude Code: add Orin's MCP config with a minted repo key; test `check_rejected` once.
6. Record the dashboard at normal 100% zoom, big window (1600px+), dark theme, no bookmarks bar.
7. Screenshot every beat as a backup in case a take flakes.

## Total talking words about 285 (fits comfortably; the rest is text + music).
```

Cut times: 6+15+4+20+2+10+5+26+14+14+12+12+18+14+5 = 176s.
```
