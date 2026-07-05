import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { app } from "./github.js";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { startQueue } from "./worker.js";
import { QUEUE } from "./queues.js";
import { handlePreflight, handleIssueKey, handleMetrics, handleGraph } from "./preflight.js";
import { handleAuthStart, handleAuthCallback, handleLogout, handleMe } from "./auth.js";
import { handleDash } from "./dash.js";
import { forgetTenant } from "./lifecycle.js";
import { DECISION_OWL, ONTOLOGY_KEY, ONTOLOGY_FILENAME } from "./ontology.js";

async function main() {
  await db.initSchema();
  const boss = await startQueue();
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

    // Ground extraction with the decision ontology (idempotent-ish: duplicate key 400s, which we ignore).
    await cognee
      .uploadOntology(cog, creds, { ontologyKey: ONTOLOGY_KEY, filename: ONTOLOGY_FILENAME, content: DECISION_OWL })
      .catch((e) => console.warn("ontology upload skipped:", (e as Error).message));

    for (const r of payload.repositories ?? []) {
      await boss.send(QUEUE.ingest, { installationId, repo: r.full_name });
    }
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

  createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && pathname === "/api/github/webhooks") {
      void handleWebhook(req, res);
      return;
    }
    if (req.method === "POST" && pathname === "/v1/preflight") {
      void handlePreflight(req, res);
      return;
    }
    if (req.method === "POST" && pathname === "/v1/preflight-keys") {
      void handleIssueKey(req, res);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/metrics") {
      void handleMetrics(req, res);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/graph") {
      void handleGraph(req, res);
      return;
    }
    // Dashboard sign-in + API (session-cookie auth).
    if (req.method === "GET" && pathname === "/v1/auth/github") {
      handleAuthStart(res);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/auth/callback") {
      void handleAuthCallback(req, res).catch((e) => {
        console.error("auth callback failed:", (e as Error).message);
        res.writeHead(500).end("sign-in failed");
      });
      return;
    }
    if (pathname === "/v1/auth/logout") {
      handleLogout(res);
      return;
    }
    if (req.method === "GET" && pathname === "/v1/me") {
      void handleMe(req, res);
      return;
    }
    if (pathname.startsWith("/v1/dash/")) {
      void handleDash(req, res, pathname).then((handled) => {
        if (!handled) res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
  }).listen(config.port, () => console.log(`Orin bot listening on :${config.port}`));
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
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const payload = Buffer.concat(chunks).toString("utf8"); // exact bytes GitHub signed
    app.webhooks
      .verifyAndReceive({ id, name: name as never, signature, payload })
      .then(() => res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'))
      .catch((e: Error) => {
        console.warn("webhook rejected:", e.message);
        res.writeHead(400).end("invalid signature or handler error");
      });
  });
  req.on("error", () => res.writeHead(400).end("read error"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
