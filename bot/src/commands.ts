import PgBoss from "pg-boss";
import * as db from "./db.js";
import { installationOctokit } from "./github.js";
import { ask, overrideDecision } from "./pipeline.js";
import { QUEUE } from "./queues.js";
import type { CommandJob } from "./queues.js";
import type { TenantCredentials } from "./cognee.js";

type Gh = Awaited<ReturnType<typeof installationOctokit>>;

export type Command =
  | { name: "recall"; query: string }
  | { name: "why" }
  | { name: "override"; ref?: string; reason: string }
  | { name: "ignore" }
  | { name: "rescan" };

const RE = /@codeguard\s+(recall|why|override|ignore|re-?scan)\b([^\n]*)/i;

/** Parse an `@codeguard <cmd> …` mention (pure — unit-tested). */
export function parseCommand(body: string): Command | null {
  const m = body.match(RE);
  if (!m) return null;
  const name = m[1].toLowerCase().replace("-", "");
  const rest = (m[2] ?? "").trim();
  switch (name) {
    case "recall":
      return { name: "recall", query: rest };
    case "why":
      return { name: "why" };
    case "ignore":
      return { name: "ignore" };
    case "rescan":
      return { name: "rescan" };
    case "override": {
      // @codeguard override [REF] "reason"   (REF like PR-42 optional; quotes optional)
      const quoted = rest.match(/^(\S+)?\s*"([^"]*)"/);
      if (quoted) return { name: "override", ref: quoted[1], reason: quoted[2].trim() };
      const refThenText = rest.match(/^([A-Za-z]+-\d+)\s+(.+)$/);
      if (refThenText) return { name: "override", ref: refThenText[1], reason: refThenText[2].trim() };
      return { name: "override", reason: rest };
    }
    default:
      return null;
  }
}

async function canMutate(octokit: Gh, owner: string, repo: string, username: string): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return data.permission === "admin" || data.permission === "write";
  } catch {
    return false;
  }
}

export async function handleCommand(job: CommandJob, boss: PgBoss): Promise<void> {
  const cmd = parseCommand(job.body);
  if (!cmd) return;
  const inst = await db.getInstallation(job.installationId);
  if (!inst) return;
  const creds: TenantCredentials = { apiKey: inst.cogneeApiKey, tenantId: "" };
  const [owner, repo] = job.repo.split("/");
  const octokit = await installationOctokit(job.installationId);
  const reply = (body: string) => octokit.rest.issues.createComment({ owner, repo, issue_number: job.number, body });

  // ack the command
  await octokit.rest.reactions.createForIssueComment({ owner, repo, comment_id: job.commentId, content: "eyes" }).catch(() => undefined);

  switch (cmd.name) {
    case "recall":
    case "why": {
      const query = cmd.name === "recall" ? cmd.query : "Summarize the most relevant past decision and why it was made.";
      const answer = await ask(inst, creds, query);
      await reply(answer || "No relevant decision found in memory.");
      break;
    }
    case "override": {
      if (!(await canMutate(octokit, owner, repo, job.sender))) {
        await reply(`@${job.sender} — \`override\` needs write access to this repo.`);
        break;
      }
      const ref = cmd.ref ?? (await db.getLatestDecisionForPr(job.installationId, job.repo, job.number));
      if (!ref) {
        await reply("Nothing to override — no decision was cited on this thread.");
        break;
      }
      // Cross-repo IDOR guard: only a decision CodeGuard flagged on THIS repo+thread may be overridden.
      if (!(await db.decisionFlaggedOnThread(job.installationId, job.repo, job.number, ref))) {
        await reply(`@${job.sender} — \`${ref}\` was not flagged by CodeGuard on this thread, so it can't be overridden here.`);
        break;
      }
      const sourceUrl = `https://github.com/${job.repo}/${job.isPr ? "pull" : "issues"}/${job.number}`;
      const newId = await overrideDecision(inst, creds, { citedRef: ref, reason: cmd.reason, by: job.sender, number: job.number, sourceUrl });
      await reply(`✅ Recorded **${newId}** superseding **${ref}** — CodeGuard will no longer flag this decision.`);
      break;
    }
    case "ignore": {
      if (!(await canMutate(octokit, owner, repo, job.sender))) {
        await reply(`@${job.sender} — \`ignore\` needs write access.`);
        break;
      }
      await db.ignoreDeliveries(job.installationId, job.repo, job.number);
      await reply("👍 CodeGuard will stop flagging this thread.");
      break;
    }
    case "rescan": {
      await boss.send(QUEUE.catch, {
        installationId: job.installationId,
        repo: job.repo,
        kind: job.isPr ? "pr" : "issue",
        number: job.number,
      });
      await reply("🔄 Re-scanning this against recorded decisions…");
      break;
    }
  }
}
