#!/usr/bin/env node
// Orin pre-flight CLI. Checks the current branch against your repo's recorded decisions.
//   ORIN_TOKEN=orin_… ORIN_URL=https://…/v1/preflight  orin [baseBranch]
import { execFileSync } from "node:child_process";

const endpoint = process.env.ORIN_URL ?? "https://orin.example/v1/preflight";
const token = process.env.ORIN_TOKEN;
if (!token) {
  console.error("Set ORIN_TOKEN to your repo-scoped orin_ key.");
  process.exit(2);
}
const base = process.argv[2] ?? "main";

// execFile with an argument array — no shell, so the branch name can't inject.
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const diff = git("diff", "--unified=0", `origin/${base}...HEAD`);
const title = git("log", "-1", "--format=%s").trim();

const res = await fetch(endpoint, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ title, diff }),
});
if (!res.ok) {
  console.error(`Orin: ${res.status} ${await res.text()}`);
  process.exit(2);
}
const j = await res.json();
if (j.matches) {
  console.error(`⚠️  Re-proposes ${j.decisionId}:\n${j.comment}`);
  process.exit(j.blocking ? 1 : 0);
}
console.log("✅ No conflict with a rejected decision.");
