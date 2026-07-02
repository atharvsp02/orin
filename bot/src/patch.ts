import type { Anchor, PrFile } from "./types.js";

export interface DiffLine {
  path: string;
  side: "RIGHT" | "LEFT";
  headLine?: number; // set for '+' and context — the value used as review `line` / annotation line
  baseLine?: number; // set for '-' and context
  add: boolean;
  content: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a file's unified-diff patch into per-line head/base positions (pure). */
export function parsePatch(path: string, patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let head = 0;
  let base = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const m = raw.match(HUNK);
    if (m) {
      base = Number(m[1]);
      head = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const c = raw[0];
    if (c === "+") {
      out.push({ path, side: "RIGHT", headLine: head, add: true, content: raw.slice(1) });
      head++;
    } else if (c === "-") {
      out.push({ path, side: "LEFT", baseLine: base, add: false, content: raw.slice(1) });
      base++;
    } else if (c === "\\") {
      // "\ No newline at end of file" — not a real line
    } else {
      // context (or empty)
      out.push({ path, side: "RIGHT", headLine: head, baseLine: base, add: false, content: raw.slice(1) });
      head++;
      base++;
    }
  }
  return out;
}

const SIG = /[a-z0-9][a-z0-9-]{2,}/g;
const terms = (s: string) => new Set(s.toLowerCase().match(SIG) ?? []);

function contiguousRun(added: DiffLine[], idx: number): DiffLine[] {
  let lo = idx;
  let hi = idx;
  while (lo > 0 && added[lo - 1].path === added[lo].path && added[lo - 1].headLine === added[lo].headLine! - 1) lo--;
  while (hi < added.length - 1 && added[hi + 1].path === added[hi].path && added[hi + 1].headLine === added[hi].headLine! + 1) hi++;
  return added.slice(lo, hi + 1);
}

/**
 * Pick the best added (RIGHT) line across files by overlap with a decision's terms,
 * then expand to its contiguous added run. Returns null when nothing overlaps
 * (⇒ no inline anchor; deliver as a file-level / summary-only finding).
 */
export function anchorFor(
  files: PrFile[],
  decisionTerms: string[],
  opts: { level: Anchor["level"]; message: string; suggestion?: string },
): Anchor | null {
  const want = new Set(decisionTerms.map((t) => t.toLowerCase()));
  const added = files
    .filter((f) => f.patch)
    .flatMap((f) => parsePatch(f.path, f.patch!).filter((l) => l.add));

  let bestIdx = -1;
  let bestScore = 0;
  added.forEach((l, i) => {
    let score = 0;
    for (const t of terms(l.content)) if (want.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  if (bestIdx < 0) return null;

  const run = contiguousRun(added, bestIdx);
  const startLine = run[0].headLine!;
  const line = run[run.length - 1].headLine!;
  return {
    path: run[0].path,
    side: "RIGHT",
    line,
    startLine: startLine !== line ? startLine : undefined,
    level: opts.level,
    message: opts.message,
    suggestion: opts.suggestion,
  };
}

/** ```suggestion``` fence — widens when the replacement itself contains backticks. */
export function suggestionBlock(replacement: string): string {
  const fence = replacement.includes("```") ? "````" : "```";
  return `${fence}suggestion\n${replacement}\n${fence}`;
}
