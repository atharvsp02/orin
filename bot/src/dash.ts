// Dashboard API: session-cookie auth with legacy installation and workspace routes.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspacePermission } from "./access.js";
import { config } from "./config.js";
import * as db from "./db.js";
import * as enterprise from "./enterprise-db.js";
import * as cognee from "./cognee.js";
import { authenticatedUser, hasTrustedMutationOrigin, send } from "./auth.js";
import { installationOctokit } from "./github.js";
import { listRules, rulesNodeset } from "./pipeline.js";
import * as llm from "./llm.js";
import { ONTOLOGY_KEY } from "./ontology.js";
import type { TenantCredentials } from "./cognee.js";
import type { DeliveryMode } from "./types.js";
import { handleWorkspaceAdmin } from "./admin.js";
import { handleWorkspaceKnowledge } from "./knowledge-api.js";
import { handleWorkspaceGoogleDrive } from "./google-drive.js";
import * as content from "./content-db.js";

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

export type DashboardTarget =
  | { kind: "installation"; installationId: number; resource: string; sub?: string }
  | { kind: "workspace"; workspaceId: string; resource: string; sub?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDashboardEntityId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function parseDashboardPath(pathname: string): DashboardTarget | null {
  const legacy = pathname.match(/^\/v1\/dash\/(\d+)\/([a-z]+)(?:\/([A-Za-z0-9._-]+))?$/);
  if (legacy) {
    const installationId = Number(legacy[1]);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return null;
    return {
      kind: "installation",
      installationId,
      resource: legacy[2],
      sub: legacy[3],
    };
  }
  const workspace = pathname.match(
    /^\/v1\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z]+)(?:\/([A-Za-z0-9._-]+))?$/i,
  );
  if (!workspace) return null;
  return {
    kind: "workspace",
    workspaceId: workspace[1].toLowerCase(),
    resource: workspace[2],
    sub: workspace[3],
  };
}

export function dashboardPermission(resource: string, method = "GET"): WorkspacePermission {
  if (resource === "connectors" || resource === "resources") {
    return method === "GET" ? "connectors.read" : "connectors.manage";
  }
  if (resource === "rules" || resource === "docs") {
    return method === "GET" ? "search.use" : "content.manage";
  }
  if (["decisions", "graph", "graphdata"].includes(resource)) return "search.use";
  if (resource === "keys" || resource === "settings") return "settings.manage";
  if (resource === "people" || resource === "groups") return "people.manage";
  if (resource === "policies") return "policies.manage";
  if (resource === "connectorpolicies") return "policies.manage";
  if (resource === "syncs") return method === "GET" ? "connectors.read" : "connectors.manage";
  if (resource === "disconnects") return "connectors.manage";
  if (resource === "audit") return "audit.read";
  if (resource === "chat") return "chat.use";
  if (resource === "search") return "search.use";
  return "workspace.read";
}

/** Router for dashboard API routes. Returns true when the request was handled. */
export async function handleDash(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const target = parseDashboardPath(pathname);
  if (!target) return false;

  if (!hasTrustedMutationOrigin(req)) {
    send(res, 403, { error: "untrusted request origin" });
    return true;
  }

  const auth = await authenticatedUser(req);
  if (!auth) {
    send(res, 401, { error: "not signed in" });
    return true;
  }
  const workspace = target.kind === "workspace"
    ? await db.getWorkspace(target.workspaceId)
    : await db.getWorkspaceByInstallation(target.installationId);
  if (target.kind === "workspace" && !workspace) {
    send(res, 404, { error: "unknown workspace" });
    return true;
  }
  const currentWorkspace = workspace ?? (
    target.kind === "installation" ? await db.getWorkspaceByInstallation(target.installationId) : null
  );
  if (!currentWorkspace) {
    send(res, 404, { error: "unknown workspace" });
    return true;
  }
  const permission = dashboardPermission(target.resource, req.method ?? "GET");
  const allowed = resourceUsesContext(target.resource)
    ? Boolean(await enterprise.getWorkspaceAccess(auth.user.userId, currentWorkspace.workspaceId))
    : await enterprise.userCan(auth.user.userId, currentWorkspace.workspaceId, permission);
  if (!allowed) {
    await enterprise.recordAuditEvent({
      workspaceId: currentWorkspace.workspaceId,
      actorUserId: auth.user.userId,
      action: "authorization.denied",
      targetType: "dashboard_resource",
      targetId: target.resource,
      outcome: "denied",
      details: { method: req.method ?? "GET", permission },
    });
    send(res, 403, { error: `no access to this ${target.kind}` });
    return true;
  }
  const resource = target.resource;
  const sub = target.sub;
  if (await handleWorkspaceAdmin({
    req,
    res,
    workspaceId: currentWorkspace.workspaceId,
    actorUserId: auth.user.userId,
    resource,
    sub,
  })) return true;
  if (await handleWorkspaceKnowledge({
    req,
    res,
    workspaceId: currentWorkspace.workspaceId,
    userId: auth.user.userId,
    resource,
    sub,
  })) return true;
  if (await handleWorkspaceGoogleDrive({
    req,
    res,
    workspaceId: currentWorkspace.workspaceId,
    actorUserId: auth.user.userId,
    resource,
    sub,
  })) return true;
  const inst = currentWorkspace.legacyInstallationId;
  if (resource === "overview" && req.method === "GET" && inst === undefined) {
    const connectors = await db.listConnectors(currentWorkspace.workspaceId);
    const resources = (await Promise.all(connectors.map((connector) => db.listConnectorResources(connector.connectorId)))).flat();
    send(res, 200, {
      account: currentWorkspace.displayName,
      workspace: { workspaceId: currentWorkspace.workspaceId, displayName: currentWorkspace.displayName },
      connectors: connectors.map(({ connectorId, provider, displayName, status, capabilities }) => ({
        connectorId,
        provider,
        displayName,
        status,
        capabilities,
      })),
      resources: resources.map(({ resourceId, connectorId, externalId, kind, displayName, enabled }) => ({
        resourceId,
        connectorId,
        externalId,
        kind,
        displayName,
        enabled,
      })),
      syncs: await content.latestConnectorSyncs(currentWorkspace.workspaceId),
      metrics: { prsPrevented: 0, decisionsTracked: 0, rejectionsActive: 0 },
      recent: [],
      repos: [],
      links: [],
      installedRepos: [],
    });
    return true;
  }
  if (resource === "decisions" && req.method === "GET" && inst === undefined) {
    send(res, 200, { decisions: [] });
    return true;
  }
  if (inst === undefined) {
    send(res, 409, { error: "this resource requires a GitHub-compatible workspace" });
    return true;
  }
  const installation = await db.getInstallation(inst);
  if (!installation) {
    send(res, 404, { error: "unknown installation" });
    return true;
  }

  if ((resource === "connectors" || resource === "resources") && req.method === "PUT" && sub) {
    if (!isDashboardEntityId(sub)) {
      send(res, 400, { error: `invalid ${resource.slice(0, -1)} id` });
      return true;
    }
    let body: { enabled?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { enabled?: unknown };
    } catch {
      send(res, 400, { error: "invalid json" });
      return true;
    }
    if (typeof body.enabled !== "boolean") {
      send(res, 400, { error: "enabled must be a boolean" });
      return true;
    }
    if (!currentWorkspace) {
      send(res, 404, { error: "unknown workspace" });
      return true;
    }
    const updated = resource === "connectors"
      ? await db.setConnectorEnabled(currentWorkspace.workspaceId, sub, body.enabled)
      : await db.setConnectorResourceEnabled(currentWorkspace.workspaceId, sub, body.enabled);
    if (!updated) {
      send(res, 404, { error: `${resource.slice(0, -1)} not found` });
      return true;
    }
    send(res, 200, updated);
    return true;
  }

  if (resource === "overview" && req.method === "GET") {
    const [metrics, recent, repos, links, connectors, syncs] = await Promise.all([
      db.metricsAll(inst),
      db.recentDeliveries(inst, 20),
      db.distinctRepos(inst),
      db.linksFor(inst),
      currentWorkspace ? db.listConnectors(currentWorkspace.workspaceId) : [],
      content.latestConnectorSyncs(currentWorkspace.workspaceId),
    ]);
    let resources = (await Promise.all(connectors.map((connector) => db.listConnectorResources(connector.connectorId)))).flat();
    // Repos the App is INSTALLED on, straight from GitHub (always current, covers adds/removes).
    let installedRepos: string[] = [];
    try {
      const octokit = await installationOctokit(inst);
      const rows = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
      installedRepos = rows.map((r) => r.full_name);
    } catch (e) {
      console.warn("overview: listing installed repos failed:", (e as Error).message);
    }
    const githubConnector = connectors.find((connector) => connector.provider === "github");
    if (githubConnector) {
      const knownResources = new Set(
        resources
          .filter((item) => item.connectorId === githubConnector.connectorId && item.kind === "repository")
          .map((item) => item.externalId),
      );
      const missingRepos = installedRepos.filter((repo) => !knownResources.has(repo));
      if (missingRepos.length > 0) {
        await Promise.all(missingRepos.map((repo) => db.upsertConnectorResource({
          connectorId: githubConnector.connectorId,
          externalId: repo,
          kind: "repository",
          displayName: repo,
        })));
        resources = (await Promise.all(connectors.map((connector) => db.listConnectorResources(connector.connectorId)))).flat();
      }
    }
    send(res, 200, {
      account: installation.githubAccount,
      workspace: currentWorkspace ? {
        workspaceId: currentWorkspace.workspaceId,
        displayName: currentWorkspace.displayName,
      } : null,
      connectors: connectors.map(({ connectorId, provider, displayName, status, capabilities }) => ({
        connectorId,
        provider,
        displayName,
        status,
        capabilities,
      })),
      resources: resources.map(({ resourceId, connectorId, externalId, kind, displayName, enabled }) => ({
        resourceId,
        connectorId,
        externalId,
        kind,
        displayName,
        enabled,
      })),
      metrics,
      recent,
      repos,
      links,
      installedRepos,
      syncs,
    });
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

  if (resource === "graphdata" && req.method === "GET") {
    // Clean, self-contained graph built from this tenant's real decision memory: decisions,
    // the entities/terms Cognee extracted from each, the repo, and supersession links. Rendered
    // by our own themed force layout (no third-party embed, no runtime fetch).
    const records = await db.getDecisionRecords(inst);
    type GNode = { id: string; type: "decision" | "term" | "repo"; label: string; outcome?: string; title?: string; repo?: string; url?: string; degree?: number };
    const nodes = new Map<string, GNode>();
    const edges: Array<{ source: string; target: string; kind: "has-term" | "in-repo" | "supersedes" }> = [];
    const add = (id: string, n: GNode) => { if (!nodes.has(id)) nodes.set(id, n); };
    const norm = (t: string) => t.toLowerCase().trim();
    for (const r of records) {
      const did = `d:${r.repo}:${r.decisionId}`;
      add(did, { id: did, type: "decision", label: r.decisionId, title: r.title, outcome: r.outcome, repo: r.repo, url: r.sourceUrl });
      const rid = `r:${r.repo}`;
      add(rid, { id: rid, type: "repo", label: r.repo.split("/")[1] ?? r.repo });
      edges.push({ source: did, target: rid, kind: "in-repo" });
      for (const t of (r.terms ?? []).map(norm).filter((t) => t.length > 1).slice(0, 6)) {
        const tid = `t:${t}`;
        add(tid, { id: tid, type: "term", label: t });
        edges.push({ source: did, target: tid, kind: "has-term" });
      }
      if (r.supersededBy) edges.push({ source: `d:${r.repo}:${r.supersededBy}`, target: did, kind: "supersedes" });
    }
    // degree (for node sizing on the client)
    for (const e of edges) {
      const a = nodes.get(e.source); const b = nodes.get(e.target);
      if (a) a.degree = (a.degree ?? 0) + 1;
      if (b) b.degree = (b.degree ?? 0) + 1;
    }
    // drop supersession edges whose endpoint decision was not ingested
    const valid = edges.filter((e) => nodes.has(e.source) && nodes.has(e.target));
    send(res, 200, {
      nodes: [...nodes.values()],
      edges: valid,
      stats: {
        decisions: [...nodes.values()].filter((n) => n.type === "decision").length,
        entities: [...nodes.values()].filter((n) => n.type === "term").length,
      },
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
        "Cache-Control": "private, no-store, max-age=0",
        Vary: "Cookie",
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

function resourceUsesContext(resource: string): boolean {
  return resource === "search" || resource === "chat";
}
