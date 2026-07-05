// Orin Slack adapter (Bolt) — thin over the decision core. Multi-workspace OAuth: every new
// workspace is auto-provisioned its OWN isolated brain on install, and can later switch to a
// GitHub installation's memory via the one-time link-code flow (`/orin link` → `@orin link CODE`).
import { createHash, randomBytes } from "node:crypto";
import bolt from "@slack/bolt";
import type { Installation, InstallationQuery } from "@slack/bolt";
import * as db from "./db.js";
import { resolveTenant, provisionAndLink } from "./tenant.js";
import type { Tenant } from "./tenant.js";
import * as prim from "./primitives.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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
    // Self-serve: a new workspace gets its own isolated brain immediately (no-op when already linked).
    await provisionAndLink({ platform: "slack", externalId: id }, `slack:${installation.team?.name ?? id}`).catch((e) =>
      console.error("slack auto-provision failed:", (e as Error).message),
    );
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
    scopes: ["commands", "chat:write", "reactions:read", "channels:history", "app_mentions:read", "users:read"],
    installationStore,
  });
  registerHandlers(app);
  return app;
}

// Workspace-admin check (needs users:read). Fail closed: unknown → not admin.
async function isWorkspaceAdmin(client: { users: { info: (a: { user: string }) => Promise<{ user?: { is_admin?: boolean; is_owner?: boolean; is_primary_owner?: boolean } }> } }, userId: string): Promise<boolean> {
  try {
    const { user } = await client.users.info({ user: userId });
    return Boolean(user?.is_admin || user?.is_owner || user?.is_primary_owner);
  } catch {
    return false;
  }
}

// Cheap gate so we don't run the LLM on ordinary chatter — only on proposal-shaped messages.
function looksLikeProposal(text: string): boolean {
  return /\b(should we|let'?s|propose|switch to|migrate to|introduce|add (a|the)?\s?\w+ (dependency|library|package)|use \w+ instead)\b/i.test(
    text,
  );
}

function registerHandlers(app: InstanceType<typeof App>): void {
  // /why [repo:owner/name] <question> — ack fast (<3s), then answer with a cited message.
  // A workspace linked to a GitHub org holds ALL that org's repos in one memory; the repo:
  // token narrows the question to one of them.
  app.command("/why", async ({ command, ack, respond }) => {
    await ack();
    const tenant = await tenantForTeam(command.team_id);
    if (!tenant) {
      await respond("Orin has no memory for this workspace yet — reinstall the app, or run `/orin help`.");
      return;
    }
    const raw = command.text?.trim() ?? "";
    const repo = raw.match(/\brepo:(\S+)/i)?.[1];
    const question = raw.replace(/\brepo:\S+\s*/i, "").trim() || "Summarize the most relevant past decision and why it was made.";
    const answer = await prim.ask(tenant, repo ? `In repository ${repo}: ${question}` : question);
    await respond({
      blocks: [{ type: "section", text: { type: "mrkdwn", text: answer || "No relevant decision found in memory." } }],
    });
  });

  // /orin — workspace management: link to a GitHub org's memory, status, repos, unlink, help.
  // link/unlink change what memory the whole workspace uses → workspace admins only.
  app.command("/orin", async ({ command, ack, respond, client }) => {
    await ack();
    const teamId = command.team_id ?? "";
    const [sub = "help", ...rest] = (command.text ?? "").trim().split(/\s+/);
    const ephemeral = (text: string) => respond({ response_type: "ephemeral", text });
    const requireAdmin = async (): Promise<boolean> => {
      if (await isWorkspaceAdmin(client, command.user_id)) return true;
      await ephemeral("⛔ `link` and `unlink` change this workspace's memory — workspace admins only.");
      return false;
    };

    switch (sub.toLowerCase()) {
      case "link": {
        if (!(await requireAdmin())) break;
        // Mint a one-time code bound to THIS workspace. It is consumed on GitHub by someone
        // with write access (`@orin link CODE`), which links this workspace to that org's memory.
        // 16 bytes = 128-bit entropy (hex keeps it case-insensitive for the consume side); combined
        // with single-use + 15-min expiry + every guess being a public GitHub comment, unguessable.
        const code = randomBytes(16).toString("hex").toUpperCase();
        await db.insertLinkCode(sha256(code), "slack", teamId, 15);
        await ephemeral(
          `🔗 Link code: \`${code}\` (expires in 15 minutes, single-use).\n` +
            `Have someone with *write access* comment \`@orin link ${code}\` on any issue/PR in the GitHub org you want to connect. ` +
            `That replaces this workspace's current memory with the org's decision memory.`,
        );
        break;
      }
      case "status": {
        const tenant = await tenantForTeam(teamId);
        if (!tenant) {
          await ephemeral("No memory linked. Reinstall the app to auto-provision one, or run `/orin link`.");
          break;
        }
        const [count, repos] = await Promise.all([
          db.countDecisions(tenant.installationId),
          db.distinctRepos(tenant.installationId),
        ]);
        const kind = tenant.inst.githubAccount.startsWith("slack:") ? "own workspace memory" : `GitHub memory of *${tenant.inst.githubAccount}*`;
        await ephemeral(`📊 Linked to ${kind} — ${count} decisions${repos.length ? ` across: ${repos.join(", ")}` : ""}.`);
        break;
      }
      case "repos": {
        const tenant = await tenantForTeam(teamId);
        const repos = tenant ? await db.distinctRepos(tenant.installationId) : [];
        await ephemeral(repos.length ? `Repos with recorded decisions:\n${repos.map((r) => `• \`${r}\` — try \`/why repo:${r} …\``).join("\n")}` : "No repo-scoped decisions yet.");
        break;
      }
      case "unlink": {
        if (!(await requireAdmin())) break;
        // Detach from the current memory and provision a fresh, empty one for this workspace.
        await db.unlinkTenant("slack", teamId);
        await provisionAndLink({ platform: "slack", externalId: teamId }, `slack:${teamId}`);
        await ephemeral("🧹 Unlinked. This workspace now has its own fresh, empty memory.");
        break;
      }
      default:
        void rest;
        await ephemeral(
          "*Orin commands*\n" +
            "• `/why [repo:owner/name] <question>` — ask why a decision was made\n" +
            "• `/orin link` — get a code to connect this workspace to a GitHub org's memory\n" +
            "• `/orin status` — what memory this workspace uses\n" +
            "• `/orin repos` — repos with recorded decisions\n" +
            "• `/orin unlink` — detach and start a fresh workspace memory\n" +
            "• React with :decision: on any message to record it as a decision",
        );
    }
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
