import { createServer } from "node:http";
import { App, createNodeMiddleware } from "@octokit/app";
import { startQueue, QUEUE } from "./worker.js";

async function main() {
  const boss = await startQueue();

  const app = new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_PRIVATE_KEY!,
    webhooks: { secret: process.env.GITHUB_WEBHOOK_SECRET! },
  });

  // New install -> provision a Cognee tenant + backfill (done async by the worker).
  app.webhooks.on("installation.created", async ({ payload }) => {
    await boss.send(QUEUE.ingest, {
      kind: "backfill",
      installationId: payload.installation.id,
      account: payload.installation.account?.login,
      repos: payload.repositories?.map((r) => r.full_name) ?? [],
    });
  });

  // New PR -> catch pipeline (async). Webhook acks fast; heavy work runs on the queue.
  app.webhooks.on("pull_request.opened", async ({ payload }) => {
    await boss.send(QUEUE.catch, {
      installationId: payload.installation?.id,
      repo: payload.repository.full_name,
      prNumber: payload.pull_request.number,
    });
  });

  const port = Number(process.env.PORT ?? 3000);
  createServer(createNodeMiddleware(app)).listen(port, () =>
    console.log(`CodeGuard bot listening on :${port}`),
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
