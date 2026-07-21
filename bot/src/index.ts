import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { app } from "./github.js";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { startQueue } from "./worker.js";
import { QUEUE, safeJobError } from "./queues.js";
import { handlePreflight, handleIssueKey, handleMetrics, handleGraph } from "./preflight.js";
import { handleAuthStart, handleAuthCallback, handleLogout, handleMe, send } from "./auth.js";
import { handleDash } from "./dash.js";
import { forgetTenant } from "./lifecycle.js";
import { DECISION_OWL, ONTOLOGY_KEY, ONTOLOGY_FILENAME } from "./ontology.js";
import {
  handleGoogleDriveCallback,
  handleGoogleDriveStart,
  setGoogleDriveQueue,
} from "./google-drive.js";

async function syncGithubResources(
  installationId: number,
  repositories: Array<{ full_name: string }>,
  enabled: boolean,
): Promise<void> {
  const connector = await db.getConnector("github", String(installationId));
  if (!connector) return;
  for (const repository of repositories) {
    await db.upsertConnectorResource({
      connectorId: connector.connectorId,
      externalId: repository.full_name,
      kind: "repository",
      displayName: repository.full_name,
      enabled,
    });
  }
}

async function main() {
  await db.initSchema();
  const boss = await startQueue();
  setGoogleDriveQueue(boss);
  const cog = { baseUrl: config.cogneeBaseUrl };

  // New install -> provision an isolated Cognee tenant, then backfill each repo (async).
  app.webhooks.on("installation.created", async ({ payload }) => {
    const installationId = payload.installation.id;
    const acct = payload.installation.account;
    const account = (acct && "login" in acct ? acct.login : undefined) ?? `install-${installationId}`;
    const datasetName = `repo-${installationId}`;

    const creds = await cognee.provisionTenant(cog, {
      email: `bot-${installationId}@orin.io`,
      password: randomBytes(18).toString("hex"),
      tenantName: `install-${installationId}`,
    });
    await db.upsertInstallation({ installationId, githubAccount: account, datasetName, cogneeApiKey: creds.apiKey });
    await syncGithubResources(installationId, payload.repositories ?? [], true);

    // Ground extraction with the decision ontology (idempotent-ish: duplicate key 400s, which we ignore).
    await cognee
      .uploadOntology(cog, creds, { ontologyKey: ONTOLOGY_KEY, filename: ONTOLOGY_FILENAME, content: DECISION_OWL })
      .catch((e) => console.warn("ontology upload skipped:", (e as Error).message));

    for (const r of payload.repositories ?? []) {
      await boss.send(QUEUE.ingest, { installationId, repo: r.full_name });
    }
  });

  app.webhooks.on("installation_repositories.added", async ({ payload }) => {
    await syncGithubResources(payload.installation.id, payload.repositories_added, true);
  });

  app.webhooks.on("installation_repositories.removed", async ({ payload }) => {
    await syncGithubResources(payload.installation.id, payload.repositories_removed, false);
  });

  // Uninstall -> forget() the tenant's whole graph, then tear down local rows (the live forget verb).
  app.webhooks.on("installation.deleted", async ({ payload }) => {
    const installationId = payload.installation.id;
    const inst = await db.getInstallation(installationId);
    if (inst) await forgetTenant(inst).catch((e) => console.warn("forget failed:", e));
    await db.deleteInstallation(installationId);
  });

  // New/updated PR (incl. draft) -> catch pipeline (async). Ack is fast; heavy work runs on the queue.
  app.webhooks.on(
    ["pull_request.opened", "pull_request.reopened", "pull_request.ready_for_review", "pull_request.synchronize"],
    async ({ payload }) => {
      if (!payload.installation) return;
      await boss.send(QUEUE.catch, {
        installationId: payload.installation.id,
        repo: payload.repository.full_name,
        kind: "pr",
        number: payload.pull_request.number,
      });
    },
  );

  // New issue -> catch against rejected decisions before any code is written.
  app.webhooks.on("issues.opened", async ({ payload }) => {
    if (!payload.installation) return;
    await boss.send(QUEUE.catch, {
      installationId: payload.installation.id,
      repo: payload.repository.full_name,
      kind: "issue",
      number: payload.issue.number,
    });
  });

  // `@orin <cmd>` in a PR/issue comment -> command queue (recall/why/override/ignore/rescan).
  app.webhooks.on("issue_comment.created", async ({ payload }) => {
    if (!payload.installation || payload.comment.user?.type === "Bot") return;
    await boss.send(QUEUE.command, {
      installationId: payload.installation.id,
      repo: payload.repository.full_name,
      number: payload.issue.number,
      commentId: payload.comment.id,
      body: payload.comment.body ?? "",
      sender: payload.comment.user?.login ?? "",
      isPr: Boolean(payload.issue.pull_request),
    });
  });

  // Closed PR / issue -> live ingest of that single decision (memory compounds forward).
  app.webhooks.on("pull_request.closed", async ({ payload }) => {
    if (!payload.installation) return;
    await boss.send(QUEUE.ingest, {
      installationId: payload.installation.id,
      repo: payload.repository.full_name,
      number: payload.pull_request.number,
    });
  });
  app.webhooks.on("issues.closed", async ({ payload }) => {
    if (!payload.installation) return;
    await boss.send(QUEUE.ingest, {
      installationId: payload.installation.id,
      repo: payload.repository.full_name,
      number: payload.issue.number,
    });
  });

  const server = createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && pathname === "/api/github/webhooks") {
      void handleWebhook(req, res).catch((error) => failRequest(res, "webhook failed", error));
      return;
    }
    if (req.method === "POST" && pathname === "/v1/preflight") {
      void handlePreflight(req, res).catch((error) => failRequest(res, "preflight failed", error));
      return;
    }
    if (req.method === "POST" && pathname === "/v1/preflight-keys") {
      void handleIssueKey(req, res).catch((error) => failRequest(res, "key issuance failed", error));
      return;
    }
    if (req.method === "GET" && pathname === "/v1/metrics") {
      void handleMetrics(req, res).catch((error) => failRequest(res, "metrics failed", error));
      return;
    }
    if (req.method === "GET" && pathname === "/v1/graph") {
      void handleGraph(req, res).catch((error) => failRequest(res, "graph failed", error));
      return;
    }
    // Dashboard sign-in + API (session-cookie auth).
    if (req.method === "GET" && pathname === "/v1/auth/github") {
      handleAuthStart(req, res);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/auth/callback") {
      void handleAuthCallback(req, res).catch((e) => {
        failRequest(res, "auth callback failed", e);
      });
      return;
    }
    if (pathname === "/v1/auth/logout") {
      handleLogout(res);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/me") {
      void handleMe(req, res).catch((error) => failRequest(res, "session lookup failed", error));
      return;
    }
    if (req.method === "GET" && pathname === "/v1/connectors/google-drive/start") {
      void handleGoogleDriveStart(req, res).catch((error) => {
        failRequest(res, "Google Drive OAuth start failed", error);
      });
      return;
    }
    if (req.method === "GET" && pathname === "/v1/connectors/google-drive/callback") {
      void handleGoogleDriveCallback(req, res).catch((error) => {
        failRequest(res, "Google Drive OAuth callback failed", error);
      });
      return;
    }
    if (pathname.startsWith("/v1/dash/") || pathname.startsWith("/v1/workspaces/")) {
      void handleDash(req, res, pathname).then((handled) => {
        if (!handled) res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      }).catch((error) => failRequest(res, "dashboard request failed", error));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.listen(config.port, () => console.log(`Orin bot listening on :${config.port}`));
}

function failRequest(res: ServerResponse, label: string, error: unknown): void {
  console.error(`${label}:`, safeJobError(error));
  if (!res.headersSent) send(res, 500, { error: "internal request failure" });
  else if (!res.writableEnded) res.end();
}

// Verify + dispatch a GitHub App webhook using the App's own webhooks instance (App-JWT auth, no OAuth).
async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = String(req.headers["x-github-delivery"] ?? "");
  const name = String(req.headers["x-github-event"] ?? "");
  const signature = String(req.headers["x-hub-signature-256"] ?? "");
  if (!id || !name || !signature) {
    res.writeHead(400).end("missing webhook headers");
    return;
  }
  const maxBytes = 25 * 1024 * 1024;
  const declaredBytes = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    res.writeHead(413).end("webhook payload too large");
    return;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) {
      res.writeHead(413).end("webhook payload too large");
      return;
    }
    chunks.push(buffer);
  }
  const payload = Buffer.concat(chunks).toString("utf8");
  try {
    await app.webhooks.verifyAndReceive({ id, name: name as never, signature, payload });
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  } catch (error) {
    console.warn("webhook rejected:", safeJobError(error));
    res.writeHead(400).end("invalid signature or handler error");
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
