import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createNodeMiddleware } from "octokit";
import { config } from "./config.js";
import { app } from "./github.js";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { startQueue, QUEUE } from "./worker.js";

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

  // New PR -> catch pipeline (async). The webhook acks fast; heavy work runs on the queue.
  app.webhooks.on("pull_request.opened", async ({ payload }) => {
    if (!payload.installation) return;
    await boss.send(QUEUE.catch, {
      installationId: payload.installation.id,
      repo: payload.repository.full_name,
      prNumber: payload.pull_request.number,
    });
  });

  createServer(createNodeMiddleware(app)).listen(config.port, () =>
    console.log(`CodeGuard bot listening on :${config.port}`),
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
