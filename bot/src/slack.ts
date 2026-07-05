// Orin Slack adapter (Bolt) — thin over the decision core. Multi-workspace OAuth; the tenant
// (which repo's memory) resolves per team via tenant_links, falling back to ORIN_DEFAULT_INSTALLATION.
import bolt from "@slack/bolt";
import type { Installation, InstallationQuery } from "@slack/bolt";
import * as db from "./db.js";
import { resolveTenant } from "./tenant.js";
import type { Tenant } from "./tenant.js";
import * as prim from "./primitives.js";

const { App } = bolt;

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Slack adapter needs ${name}`);
  return v;
}

const idOf = (q: { isEnterpriseInstall?: boolean; enterpriseId?: string; teamId?: string }): string =>
  (q.isEnterpriseInstall && q.enterpriseId ? q.enterpriseId : q.teamId) ?? "";

const installationStore = {
  async storeInstallation(installation: Installation): Promise<void> {
    const id = installation.isEnterpriseInstall && installation.enterprise ? installation.enterprise.id : installation.team?.id;
    if (!id) throw new Error("Slack installation has no team/enterprise id");
    await db.storeSlackInstall(id, installation);
  },
  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation> {
    const data = await db.fetchSlackInstall(idOf(query));
    if (!data) throw new Error("no Slack installation");
    return data as Installation;
  },
  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    await db.deleteSlackInstall(idOf(query));
  },
};

const tenantForTeam = (teamId?: string): Promise<Tenant | null> =>
  resolveTenant({ platform: "slack", externalId: teamId ?? "" });

function buildApp(): InstanceType<typeof App> {
  const app = new App({
    signingSecret: reqEnv("SLACK_SIGNING_SECRET"),
    clientId: reqEnv("SLACK_CLIENT_ID"),
    clientSecret: reqEnv("SLACK_CLIENT_SECRET"),
    stateSecret: reqEnv("SLACK_STATE_SECRET"), // signs the OAuth state param — must not be a known default (CSRF)
    scopes: ["commands", "chat:write", "reactions:read", "channels:history", "app_mentions:read"],
    installationStore,
  });
  registerHandlers(app);
  return app;
}

// Cheap gate so we don't run the LLM on ordinary chatter — only on proposal-shaped messages.
function looksLikeProposal(text: string): boolean {
  return /\b(should we|let'?s|propose|switch to|migrate to|introduce|add (a|the)?\s?\w+ (dependency|library|package)|use \w+ instead)\b/i.test(
    text,
  );
}

function registerHandlers(app: InstanceType<typeof App>): void {
  // /why <question> — ack fast (<3s), then answer with a cited Block Kit message via response_url.
  app.command("/why", async ({ command, ack, respond }) => {
    await ack();
    const tenant = await tenantForTeam(command.team_id);
    if (!tenant) {
      await respond("Orin isn't linked to a repo for this workspace yet.");
      return;
    }
    const answer = await prim.ask(tenant, command.text?.trim() || "Summarize the most relevant past decision and why it was made.");
    await respond({
      blocks: [{ type: "section", text: { type: "mrkdwn", text: answer || "No relevant decision found in memory." } }],
    });
  });

  // React with :decision: on a message to record it into memory.
  app.event("reaction_added", async ({ event, client, body }) => {
    if (event.reaction !== (process.env.SLACK_INGEST_EMOJI ?? "decision")) return;
    if (event.item.type !== "message") return;
    const tenant = await tenantForTeam((body as { team_id?: string }).team_id);
    if (!tenant) return;
    const res = await client.conversations.history({ channel: event.item.channel, latest: event.item.ts, inclusive: true, limit: 1 });
    const text = res.messages?.[0]?.text;
    if (!text) return;
    await prim.ingest(tenant, {
      kind: "doc",
      // full ts digits (e.g. 1699999999.123456 → 1699999999123456) — unique per message, so
      // re-reacting is idempotent and distinct messages never collide on DOC-<n>.
      number: Number(event.item.ts.replace(".", "")),
      title: text.slice(0, 80),
      body: text,
      url: "",
      repo: "",
    });
  });

  // Proposal-shaped top-level messages get a collision check against rejected decisions.
  app.message(async ({ message, say, body }) => {
    const m = message as { subtype?: string; text?: string; ts?: string };
    if (m.subtype || !m.text || !looksLikeProposal(m.text)) return;
    const tenant = await tenantForTeam((body as { team_id?: string }).team_id);
    if (!tenant) return;
    const j = await prim.warn(tenant, m.text);
    if (j.matches && j.comment) await say({ thread_ts: m.ts, text: `⚠️ ${j.comment}` });
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.SLACK_PORT ?? 3001);
  try {
    await buildApp().start(port);
    console.log(`orin-slack listening on :${port}`);
  } catch (e) {
    console.error(`orin-slack: ${(e as Error).message}`);
    process.exit(2);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("slack.js") || entry.endsWith("slack.ts")) void main();
