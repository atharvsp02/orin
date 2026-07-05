# Orin: 3-minute demo shot list (read-and-record)

How to read this:
- 🎙️ YOU TALK  = you screen-record this and speak the **SAY** lines word for word.
- 🔇 NO TALK    = no voice. Just screen action + text on screen + music. I build the text in Remotion.

Rhythm: music+text intro (silent) → you talk → text card (silent) → demo you talk → text →
demo you talk … it alternates the whole way. Total ~157s, comfortably under the 180s cap.

The catch is shown on an **issue** (no live PR). We simply say the same thing happens on pull
requests as a merge-blocking check. That keeps the demo fast and reliable.

You record the 🎙️ cuts and the raw screen for the 🔇 cuts, and send me the clips in order.
I assemble + add all text cards, highlights, and music.

---

## Demo data (use these EXACT values; they match what's really seeded in the repo)

- Repo on screen: **`ydark926/orin-demo`** (already has OrinBot + 12 real decisions seeded).
- The decision topic: **Redis caching** (universal, everyone gets it).
- The existing decision (already closed + rejected, this is ISSUE-1):
  **"Add Redis as a caching layer for search results"**
- Its real rejection reasoning (already on the issue, this is what Orin cites):
  "Adding Redis means another stateful service to deploy, monitor, and scale on every
  self-hosted install, and it adds a cache-invalidation problem. Our in-process caching plus the
  vector store's own caching already cover the hot paths."
- The NEW re-proposal issue you create live (the catch):
  title **"Add a Redis cache in front of search"**, body "Search feels slow on big datasets.
  Let's put Redis in front of the retrieval path to cache lookups."
- Slack question (verified, returns a cited answer scoped to the repo): **`/why orin-demo why redis cancelled`**

Note on handles: on GitHub always type **`@orinbot`** (not `@orin`, which tags a real GitHub
user). In Linear the agent is mentioned as **`@Orin`** (its Linear app name). In Slack it's the
slash command **`/orin`**.

---

## THE CUTS

### CUT 1: Brand intro  🔇 NO TALK  (~6s)
- Screen: none (I build it). Black `#09090B`, Orin mark fades in, tagline under it, soft music rising.
- Text on screen: **Orin** / small under it: **institutional memory for engineering teams**

### CUT 2: The hook  🎙️ YOU TALK  (~15s)
- Screen: slow scroll down the Orin homepage (hero + the tilted dashboard). Record ~15s of calm scroll.
- SAY:
  "Every engineering team rejects ideas for good reasons. Then the people who remember those
  reasons move on. Months later the same idea comes back, and nobody remembers why you said no.
  Orin is the memory that does."

### CUT 3: Transition card  🔇 NO TALK  (~4s)
- Screen: none (I build it).
- Text on screen: **First, a decision the team already made.**

### CUT 4: The decision  🎙️ YOU TALK  (~20s)
- Screen: GitHub `ydark926/orin-demo` → open issue **ISSUE-1 "Add Redis as a caching layer for
  search results"** (it's already Closed / rejected) → scroll through the rejection comment. Record it.
- SAY:
  "Here's a real repo. A while back someone proposed adding Redis as a caching layer. A maintainer
  said no: it's another service to run and monitor, and existing caching already covers it. They
  closed the issue. No special syntax, nothing. Orin just read that decision into its memory."

### CUT 5: Time jump  🔇 NO TALK  (~2s)
- Text on screen: **Orin remembered it.**

### CUT 6: Decision recorded  🎙️ YOU TALK  (~10s)
- Screen: Orin dashboard → Decisions → ISSUE-1 showing REJECTED with the reasoning. Record it.
- SAY:
  "And there it is in the dashboard. The decision, the reasoning, marked rejected. Remember this,
  because the team only recorded it once."

### CUT 7: Act card  🔇 NO TALK  (~5s, music lifts)
- Text on screen: **One decision.** then **Every surface.** with four logos appearing:
  GitHub, Slack, Linear, Cursor.

### CUT 8: THE CATCH (the big one)  🎙️ YOU TALK  (~26s)
- Screen: GitHub `ydark926/orin-demo` → click **New issue** → title **"Add a Redis cache in front
  of search"**, paste the body → Submit. Then (cut the wait) show Orin's **⚠️ warning comment**
  that appears on the issue, citing ISSUE-1 with its reasoning. Zoom on the citation.
- TIP: create this issue OFF-camera first so Orin's comment is already there, then record scrolling
  the issue + its warning. Avoids waiting on the pipeline live.
- SAY:
  "Weeks later, someone new proposes exactly that again. And Orin catches it right here on the
  issue, before anyone writes a line of code. Not 'this looks risky.' It cites the exact past
  decision, the reasoning, and links the original thread. And the same thing happens on pull
  requests, where Orin becomes a merge-blocking check. That's the whole product, right there."

### CUT 9: Slack  🔇 NO TALK  (~14s)
- Screen: Slack → type `/why orin-demo why redis cancelled` → Orin's cited answer appears. Record it.
- Text on screen (I add): **In Slack: /why** then **Same decision. With evidence.**
- (Already linked and verified, so this just works.)

### CUT 10: Linear (text card)  🔇 NO TALK  (~4s)
- Screen: none (I build it). Linear logo + text, same card style as the others.
- Text on screen: **And the same in Linear** then small: **@Orin answers in issues and warns on new ones.**
- Shown textually, no recording.

### CUT 11: MCP setup (Keys + Integrations)  🎙️ YOU TALK  (~14s)
- Screen: Orin dashboard → **Keys** → mint a repo-scoped key (show it appear in the list) →
  **Integrations** → show the **MCP · Cursor, Claude Code, CLI** card with the config snippet.
- SAY:
  "Your coding agents plug in over MCP. Mint a repo-scoped key here, drop this config into Cursor
  or Claude Code, and they check the same memory before a pull request even exists."

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
- SAY: "Orin. Remember the past, ship the future."

---

## What I build vs what you record
- I build (no recording needed): CUT 1, 3, 5, 7, 10, 15 text/brand cards, the CUT 14 lifecycle
  animation, and ALL the on-screen text/highlights/music on top of your clips.
- You record (screen, some with your voice): CUT 2, 4, 6, 8, 11, 14 (you talk) and CUT 9, 13
  (screen only, no voice).

## Before you record (most of this is already done)
1. DONE: OrinBot installed on `ydark926/orin-demo`; 12 real decisions seeded incl. ISSUE-1.
2. DONE: Slack linked to orin-demo's memory; `/why orin-demo why redis cancelled` verified to
   answer with citations.
3. CUT 11 is just the dashboard **Keys** and **Integrations** pages, nothing to install.
4. For CUT 8: create the "Add a Redis cache in front of search" issue OFF-camera first so Orin's
   warning comment is already posted, then record. (Issue-stage catch takes about a minute.)
5. Record the dashboard at normal 100% zoom, big window (1600px+), dark theme, no bookmarks bar.
6. Screenshot every beat as a backup in case a take flakes.

## Total talking words about 290 (fits comfortably; the rest is text + music).

Cut times: 6+15+4+20+2+10+5+26+14+4+14+18+14+5 = 157s.
