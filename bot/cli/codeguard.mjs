#!/usr/bin/env node
// CodeGuard pre-flight CLI. Checks the current branch against your repo's recorded decisions.
//   CODEGUARD_TOKEN=cg_… CODEGUARD_URL=https://…/v1/preflight  codeguard [baseBranch]
import { execFileSync } from "node:child_process";

const endpoint = process.env.CODEGUARD_URL ?? "https://codeguard.example/v1/preflight";
const token = process.env.CODEGUARD_TOKEN;
if (!token) {
  console.error("Set CODEGUARD_TOKEN to your repo-scoped cg_ key.");
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
  console.error(`CodeGuard: ${res.status} ${await res.text()}`);
  process.exit(2);
}
const j = await res.json();
if (j.matches) {
  console.error(`⚠️  Re-proposes ${j.decisionId}:\n${j.comment}`);
  process.exit(j.blocking ? 1 : 0);
}
console.log("✅ No conflict with a rejected decision.");
