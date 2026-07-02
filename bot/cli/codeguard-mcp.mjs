#!/usr/bin/env node
// CI gate over MCP: spawns the CodeGuard MCP server (stdio) and calls check_rejected.
// Exits 1 when the change re-proposes a rejected decision.
//   CODEGUARD_TOKEN=cg_…  node bot/cli/codeguard-mcp.mjs [baseBranch]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.CODEGUARD_TOKEN) {
  console.error("Set CODEGUARD_TOKEN to your repo-scoped cg_ key.");
  process.exit(2);
}
const base = process.argv[2] ?? "main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const text = `${git("log", "-1", "--format=%s").trim()}\n\n${git("diff", "--unified=0", `origin/${base}...HEAD`)}`;

const serverPath = fileURLToPath(new URL("../dist/mcp.js", import.meta.url));
const transport = new StdioClientTransport({ command: "node", args: [serverPath], env: { ...process.env } });
const client = new Client({ name: "codeguard-cli", version: "1.0.0" });

await client.connect(transport);
try {
  const res = await client.callTool({ name: "check_rejected", arguments: { text } });
  const payload = JSON.parse(res.content?.[0]?.text ?? "{}");
  if (payload.matches) {
    console.error(`⚠️  Re-proposes ${payload.decisionId}:\n${payload.comment}`);
    process.exit(1);
  }
  console.log("✅ No conflict with a rejected decision.");
} finally {
  await client.close();
}
