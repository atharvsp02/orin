import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createNodeMiddleware } from "octokit";
import { config } from "./config.js";
import { app } from "./github.js";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { startQueue } from "./worker.js";
import { QUEUE } from "./queues.js";
import { handlePreflight, handleIssueKey } from "./preflight.js";

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
      email: `bot-${installationId}@codeguard.io`,
      password: randomBytes(18).toString("hex"),
      tenantName: `install-${installationId}`,
    });
    await db.upsertInstallation({ installationId, githubAccount: account, datasetName, cogneeApiKey: creds.apiKey });

    for (const r of payload.repositories ?? []) {
      await boss.send(QUEUE.ingest, { installationId, repo: r.full_name });
    }
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

  // `@codeguard <cmd>` in a PR/issue comment -> command queue (recall/why/override/ignore/rescan).
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

  const middleware = createNodeMiddleware(app);
  createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/preflight") {
      void handlePreflight(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/v1/preflight-keys") {
      void handleIssueKey(req, res);
      return;
    }
    void middleware(req, res);
  }).listen(config.port, () => console.log(`CodeGuard bot listening on :${config.port}`));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
