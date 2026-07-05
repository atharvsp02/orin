# Orin demo: what YOU record (hand me these clips)

Record these and send them all. I assemble everything, add the text cards, highlights, the
Cognee animation, and music. You do NOT record the intro/close/transition cards (I build those).

Setup once, before recording:
- Browser window 1600px+ wide, **100% zoom**, dark theme, hide the bookmarks bar.
- Screen-record at the highest resolution you can. For talking clips, speak clearly and calmly.
- Name each file with its clip number (below) so they line up in order.

Two kinds of clips:
- 🎙️ TALK  = record the screen AND speak the SAY lines.
- 🔇 SILENT = record the screen only, no voice.
- 🎤 VOICE ONLY = just record you saying the line (no screen; I supply the visual).

Values to reuse (already true in the repo): repo **`ydark926/orin-demo`**, existing decision
**ISSUE-1 "Add Redis as a caching layer for search results"** (closed, rejected).

---

## A. TALK clips (screen + your voice)

### clip-02-homepage  🎙️ TALK  (~15s)
- Screen: the Orin homepage. Slowly scroll from the top (hero + tilted dashboard) down a bit.
- SAY:
  "Every engineering team rejects ideas for good reasons. Then the people who remember those
  reasons move on. Months later the same idea comes back, and nobody remembers why you said no.
  Orin is the memory that does."

### clip-04-decision  🎙️ TALK  (~20s)
- Screen: GitHub → `ydark926/orin-demo` → open **ISSUE-1 "Add Redis as a caching layer for search
  results"** (it's already Closed / rejected) → scroll slowly through the rejection comment.
- SAY:
  "Here's a real repo. A while back someone proposed adding Redis as a caching layer. A maintainer
  said no: it's another service to run and monitor, and existing caching already covers it. They
  closed the issue. No special syntax, nothing. Orin just read that decision into its memory."

### clip-06-dashboard-decision  🎙️ TALK  (~10s)
- Screen: Orin dashboard → **Decisions** → click the Redis decision (ISSUE-1) so the reasoning and
  the REJECTED badge are visible.
- SAY:
  "And there it is in the dashboard. The decision, the reasoning, marked rejected. Remember this,
  because the team only recorded it once."

### clip-08-the-catch  🎙️ TALK  (~26s)  ← the important one
- Prep OFF-camera first: on `ydark926/orin-demo` click **New issue**, title
  **"Add a Redis cache in front of search"**, body "Search feels slow on big datasets. Let's put
  Redis in front of the retrieval path to cache lookups.", Submit. Wait ~1 min for Orin's ⚠️
  warning comment to appear.
- Screen (record now): open that new issue and scroll to Orin's **⚠️ warning comment** that cites
  ISSUE-1 and its reasoning. Let it sit on screen a moment; hover/select the citation.
- SAY:
  "Weeks later, someone new proposes exactly that again. And Orin catches it right here on the
  issue, before anyone writes a line of code. Not 'this looks risky.' It cites the exact past
  decision, the reasoning, and links the original thread. And the same thing happens on pull
  requests, where Orin becomes a merge-blocking check. That's the whole product, right there."

### clip-11-mcp-setup  🎙️ TALK  (~14s)
- Screen: Orin dashboard → **Keys** → mint a repo-scoped key (show it appear in the list) →
  **Integrations** → show the **MCP · Cursor, Claude Code, CLI** card with the config snippet.
- SAY:
  "Your coding agents plug in over MCP. Mint a repo-scoped key here, drop this config into Cursor
  or Claude Code, and they check the same memory before a pull request even exists."

---

## B. SILENT clips (screen only, no voice)

### clip-09-slack  🔇 SILENT  (~14s)
- Screen: Slack → type **`/why orin-demo why redis cancelled`** → let Orin's cited answer render fully.
- (Already linked and verified, so it just works. Orin scopes it to the orin-demo repo and cites ISSUE-1.)

### clip-13-dashboard-tour  🔇 SILENT  (~18s)
- Screen: quick moves, ~4s each:
  1. **Catches** (stat tiles + click one catch)
  2. **Knowledge graph** (drag a few nodes around so it moves)
  3. **Rules** (open the org / repo scope dropdown)
  4. **Docs** (pick a file and hit "Teach Orin")

---

## C. VOICE ONLY (no screen; I supply the visuals)

### clip-14-cognee  🎤 VOICE ONLY  (~14s)
- SAY:
  "Under the hood this is Cognee's full memory lifecycle, running live. It remembers decisions,
  recalls them with reasoning, and when a maintainer says good catch or bad catch, it actually
  reweights the graph. Every workspace is its own private memory."

### clip-15-close  🎤 VOICE ONLY  (~5s)
- SAY:
  "Orin. Remember the past, ship the future."

---

## Order they'll be assembled in
intro card → **02** → card → **04** → card → **06** → card → **08** → **09** → Linear text card →
**11** → **13** → **14** (over animation) → **15** (over close card).

## Linear
Not recorded. I show it as a short text card ("And the same in Linear"). Nothing to set up.
