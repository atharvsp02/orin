// Orin MCP adapter — thin over the decision core (NOT a wrapper of cognee-mcp, whose raw
// remember/recall would bypass our grounding gate + supersession). Tools map 1:1 to the primitives.
// The server always calls Cognee with the TENANT's own key, never the client's token.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "./config.js";
import * as db from "./db.js";
import { resolveTenant } from "./tenant.js";
import type { Tenant } from "./tenant.js";
import * as prim from "./primitives.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface McpContext {
  tenant: Tenant;
  repo: string; // decision scope for record_decision (from the key), "" if unscoped
}

/** Resolve a `orin_…` preflight key to a tenant context (shared auth with the CLI/Action). */
export async function contextFromToken(token: string): Promise<McpContext | null> {
  const map = await db.lookupPreflightKey(sha256(token));
  if (!map) return null;
  const tenant = await resolveTenant({ provider: "github", externalId: String(map.installationId) });
  return tenant ? { tenant, repo: map.repo } : null;
}

/** Dev/demo fallback: the single configured installation, unscoped. */
export async function defaultContext(): Promise<McpContext | null> {
  if (config.defaultInstallationId == null) return null;
  const tenant = await resolveTenant({ provider: "github", externalId: String(config.defaultInstallationId) });
  return tenant ? { tenant, repo: "" } : null;
}

export function buildServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "orin", version: "1.0.0" });

  server.registerTool(
    "ask_decision",
    {
      description: "Ask why a past architectural/dependency decision was made; returns a cited answer from the repo's memory.",
      inputSchema: { query: z.string().describe("the question, e.g. 'why did we drop Redis?'") },
    },
    async ({ query }) => {
      const answer = await prim.ask(ctx.tenant, query);
      return { content: [{ type: "text", text: answer || "No relevant decision found in memory." }] };
    },
  );

  server.registerTool(
    "check_rejected",
    {
      description: "Check whether a proposed change re-proposes an already-rejected decision. Returns JSON {matches, decisionId, comment}.",
      inputSchema: { text: z.string().describe("PR title/description/diff or a proposal to check") },
    },
    async ({ text }) => {
      // Scope enforcement to the key's repo (a repo-scoped orin_ key must not check another repo).
      const j = await prim.warn(ctx.tenant, text, ctx.repo || undefined);
      return {
        content: [{ type: "text", text: JSON.stringify({ matches: j.matches, decisionId: j.decisionId, comment: j.comment }) }],
      };
    },
  );

  server.registerTool(
    "record_decision",
    {
      description: "Record a maintainer decision into the repo's memory so future proposals can be checked against it.",
      inputSchema: {
        title: z.string(),
        body: z.string().describe("the decision and its reasoning"),
        url: z.string().optional(),
      },
    },
    async ({ title, body, url }) => {
      await prim.ingest(ctx.tenant, {
        kind: "doc",
        number: parseInt(randomBytes(6).toString("hex"), 16), // collision-resistant DOC id
        title,
        body,
        url: url ?? "",
        repo: ctx.repo,
      });
      return { content: [{ type: "text", text: `Recorded "${title}".` }] };
    },
  );

  return server;
}

// --- stdio: one process per tenant (key from env) ---
async function mainStdio(): Promise<void> {
  const token = process.env.ORIN_TOKEN;
  const ctx = token ? await contextFromToken(token) : await defaultContext();
  if (!ctx) {
    console.error("orin-mcp: set ORIN_TOKEN (orin_ key) or ORIN_DEFAULT_INSTALLATION.");
    process.exit(2);
  }
  await buildServer(ctx).connect(new StdioServerTransport());
  console.error("orin-mcp: stdio ready.");
}

// --- streamable HTTP: remote, per-request tenant scope from the bearer key (stateless) ---
async function mainHttp(): Promise<void> {
  const port = Number(process.env.MCP_PORT ?? 8787);
  createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const ctx = token ? await contextFromToken(token) : null;
    if (!ctx) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "missing/invalid bearer key" }));
      return;
    }
    // Stateless: a fresh server+transport per request, torn down on close (no cross-tenant session reuse).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await buildServer(ctx).connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port, () => console.error(`orin-mcp: streamable HTTP on :${port}/mcp`));
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("mcp.js") || entry.endsWith("mcp.ts")) {
  void (process.env.MCP_HTTP ? mainHttp() : mainStdio());
}
