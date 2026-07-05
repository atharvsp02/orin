// Dashboard API: session-cookie auth, every route checks the requested installation is one the
// signed-in user administers (per GitHub, captured at login). Routes: /v1/dash/:inst/<resource>.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { sessionFrom, send } from "./auth.js";
import { installationOctokit } from "./github.js";
import { listRules, rulesNodeset } from "./pipeline.js";
import * as llm from "./llm.js";
import { ONTOLOGY_KEY } from "./ontology.js";
import type { TenantCredentials } from "./cognee.js";
import type { DeliveryMode } from "./types.js";

const cog = { baseUrl: config.cogneeBaseUrl };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function readBody(req: IncomingMessage, limit = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      len += c.length;
      if (len > limit) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Router for /v1/dash/*. Returns true when the request was handled. */
export async function handleDash(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const m = pathname.match(/^\/v1\/dash\/(\d+)\/([a-z]+)(?:\/([A-Za-z0-9._-]+))?$/);
  if (!m) return false;
  const inst = Number(m[1]);
  const resource = m[2];
  const sub = m[3];

  const session = sessionFrom(req);
  if (!session) {
    send(res, 401, { error: "not signed in" });
    return true;
  }
  if (!session.ids.includes(inst)) {
    send(res, 403, { error: "no access to this installation" });
    return true;
  }
  const installation = await db.getInstallation(inst);
  if (!installation) {
    send(res, 404, { error: "unknown installation" });
    return true;
  }

  if (resource === "overview" && req.method === "GET") {
    const [metrics, recent, repos, links] = await Promise.all([
      db.metricsAll(inst),
      db.recentDeliveries(inst, 20),
      db.distinctRepos(inst),
      db.linksFor(inst),
    ]);
    // Repos the App is INSTALLED on, straight from GitHub (always current, covers adds/removes).
    let installedRepos: string[] = [];
    try {
      const octokit = await installationOctokit(inst);
      const rows = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
      installedRepos = rows.map((r) => r.full_name);
    } catch (e) {
      console.warn("overview: listing installed repos failed:", (e as Error).message);
    }
    send(res, 200, { account: installation.githubAccount, metrics, recent, repos, links, installedRepos });
    return true;
  }

  if (resource === "decisions" && req.method === "GET") {
    const records = await db.getDecisionRecords(inst);
    send(res, 200, {
      decisions: records.map((r) => ({
        decisionId: r.decisionId,
        repo: r.repo,
        title: r.title,
        outcome: r.outcome,
        reasoning: r.reasoningText,
        decidedAt: r.decidedAt,
        supersededBy: r.supersededBy ?? null,
        sourceUrl: r.sourceUrl,
      })),
    });
    return true;
  }

  if (resource === "graph" && req.method === "GET") {
    const creds: TenantCredentials = { apiKey: installation.cogneeApiKey, tenantId: "" };
    try {
      const datasetId = await cognee.getDatasetId(cog, creds, installation.datasetName);
      if (!datasetId) {
        send(res, 404, { error: "no dataset yet" });
        return true;
      }
      const html = await cognee.visualize(cog, creds, datasetId);
      // Same sandboxing as /v1/graph: labels derive from repo content and are untrusted.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "sandbox allow-scripts; default-src 'self' 'unsafe-inline' data:; frame-ancestors 'self'",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(html);
    } catch (e) {
      send(res, 502, { error: `graph unavailable: ${(e as Error).message}` });
    }
    return true;
  }

  if (resource === "keys" && req.method === "GET") {
    send(res, 200, { keys: await db.listPreflightKeys(inst) });
    return true;
  }

  if (resource === "keys" && req.method === "POST") {
    let body: { repo?: string; label?: string };
    try {
      body = JSON.parse(await readBody(req)) as { repo?: string; label?: string };
    } catch {
      send(res, 400, { error: "invalid json" });
      return true;
    }
    const repo = (body.repo ?? "").trim();
    if (!repo) {
      send(res, 400, { error: "repo required (owner/name)" });
      return true;
    }
    const keyValue = `orin_${randomBytes(24).toString("hex")}`;
    await db.insertPreflightKey(sha256(keyValue), inst, repo, (body.label ?? "").slice(0, 80));
    send(res, 201, { key: keyValue, repo }); // plaintext shown once
    return true;
  }

  if (resource === "keys" && req.method === "DELETE" && sub) {
    const ok = await db.revokePreflightKey(inst, sub);
    send(res, ok ? 200 : 404, ok ? { revoked: true } : { error: "key not found or already revoked" });
    return true;
  }

  if (resource === "rules" && req.method === "GET") {
    const scope = new URL(req.url ?? "/", "http://x").searchParams.get("repo") || undefined;
    const creds: TenantCredentials = { apiKey: installation.cogneeApiKey, tenantId: "" };
    let rules: string[] = [];
    try {
      rules = await listRules(installation, creds, scope);
    } catch {
      rules = []; // dataset may not exist yet: an honest empty list
    }
    send(res, 200, { rules, scope: scope ?? "" });
    return true;
  }

  if (resource === "rules" && req.method === "POST") {
    let body: { text?: string };
    try {
      body = JSON.parse(await readBody(req)) as { text?: string };
    } catch {
      send(res, 400, { error: "invalid json" });
      return true;
    }
    const text = (body.text ?? "").trim();
    const scope = typeof (body as { repo?: unknown }).repo === "string" ? ((body as { repo: string }).repo.trim() || undefined) : undefined;
    if (!text) {
      send(res, 400, { error: "text required" });
      return true;
    }
    const cfg = await db.getTenantConfig(inst);
    const creds: TenantCredentials = { apiKey: installation.cogneeApiKey, tenantId: "" };
    const rules = await llm.extractRules(cfg.llmProvider, text.slice(0, 8000));
    if (rules.length > 0) {
      // Indexing (cognify) is slow; run it in the background so the UI answers immediately.
      void cognee
        .remember(cog, creds, {
          datasetName: installation.datasetName,
          filename: scope ? `coding-rules-${scope.replace(/[^a-zA-Z0-9]+/g, "-")}.txt` : "coding-rules.txt",
          content: rules.map((r) => `- ${r}`).join("\n"),
          nodeSet: rulesNodeset(scope),
          ontologyKey: ONTOLOGY_KEY,
        })
        .catch((e) => console.warn("rules remember failed:", (e as Error).message));
    }
    send(res, 200, { rules, indexing: rules.length > 0, scope: scope ?? "" });
    return true;
  }

  if (resource === "docs" && req.method === "GET") {
    send(res, 200, { docs: await db.listDocs(inst) });
    return true;
  }

  if (resource === "docs" && req.method === "POST") {
    let body: { title?: string; content?: string; extractRules?: boolean };
    try {
      body = JSON.parse(await readBody(req, 500_000)) as { title?: string; content?: string; extractRules?: boolean };
    } catch {
      send(res, 400, { error: "invalid json" });
      return true;
    }
    const title = (body.title ?? "").trim().slice(0, 120);
    const content = (body.content ?? "").trim();
    const repoScope = typeof (body as { repo?: unknown }).repo === "string" ? ((body as { repo: string }).repo.trim() || "") : "";
    if (!title || !content) {
      send(res, 400, { error: "title and content required" });
      return true;
    }
    const creds: TenantCredentials = { apiKey: installation.cogneeApiKey, tenantId: "" };
    const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "doc"}.md`;
    // Repo attribution steers retrieval and shows in citations; '' means org-wide.
    const header = repoScope ? `${title}\nRepo: ${repoScope}\n\n` : `${title}\n\n`;
    // Cognify takes tens of seconds; ingest in the background and acknowledge now.
    void cognee
      .remember(cog, creds, { datasetName: installation.datasetName, filename, content: header + content, ontologyKey: ONTOLOGY_KEY })
      .catch((e) => console.warn("doc remember failed:", (e as Error).message));
    await db.insertDoc(inst, filename, title, repoScope);
    let rules: string[] = [];
    if (body.extractRules) {
      const cfg = await db.getTenantConfig(inst);
      rules = await llm.extractRules(cfg.llmProvider, content.slice(0, 8000));
      if (rules.length > 0) {
        void cognee
          .remember(cog, creds, {
            datasetName: installation.datasetName,
            filename: repoScope ? `coding-rules-${repoScope.replace(/[^a-zA-Z0-9]+/g, "-")}.txt` : "coding-rules.txt",
            content: rules.map((r) => `- ${r}`).join("\n"),
            nodeSet: rulesNodeset(repoScope || undefined),
            ontologyKey: ONTOLOGY_KEY,
          })
          .catch((e) => console.warn("doc rules remember failed:", (e as Error).message));
      }
    }
    send(res, 202, { accepted: true, filename, rules, repo: repoScope });
    return true;
  }

  if (resource === "settings" && req.method === "GET") {
    send(res, 200, await db.getTenantConfig(inst));
    return true;
  }

  if (resource === "settings" && req.method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "invalid json" });
      return true;
    }
    const patch: Parameters<typeof db.updateTenantConfig>[1] = {};
    if (typeof body.deliveryMode === "string" && ["check", "review", "comment"].includes(body.deliveryMode))
      patch.deliveryMode = body.deliveryMode as DeliveryMode;
    if (typeof body.blockOnRepropose === "boolean") patch.blockOnRepropose = body.blockOnRepropose;
    if (typeof body.autoComment === "boolean") patch.autoComment = body.autoComment;
    if (typeof body.confidenceThreshold === "number" && body.confidenceThreshold >= 1 && body.confidenceThreshold <= 10)
      patch.confidenceThreshold = Math.floor(body.confidenceThreshold);
    if (typeof body.scoreCutoff === "number" && body.scoreCutoff > 0 && body.scoreCutoff <= 2)
      patch.scoreCutoff = body.scoreCutoff;
    if (typeof body.customInstructions === "string") patch.customInstructions = body.customInstructions.slice(0, 2000);
    // LLM provider is fixed to DeepSeek for all tenants; it is intentionally not settable.
    if (typeof body.tone === "string" && ["friendly", "terse"].includes(body.tone)) patch.tone = body.tone as "friendly" | "terse";
    await db.updateTenantConfig(inst, patch);
    send(res, 200, await db.getTenantConfig(inst));
    return true;
  }

  send(res, 405, { error: "unsupported method or resource" });
  return true;
}
