import { App } from "octokit";
import { config } from "./config.js";
import type { DecisionSource } from "./types.js";

export const app = new App({
  appId: config.github.appId,
  privateKey: config.github.privateKey,
  webhooks: { secret: config.github.webhookSecret },
});

export interface RepoItem {
  kind: DecisionSource; // "pr" | "issue"
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  stateReason: string | null;
  labels: string[];
  closedAt: string | null;
  comments: string[];
}

/** Fetch closed, signal-rich issues + PRs (with comments) for backfill. */
export async function fetchClosedItems(installationId: number, repoFullName: string, limit = 50): Promise<RepoItem[]> {
  const octokit = await app.getInstallationOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "closed",
    per_page: 100,
  });

  const items: RepoItem[] = [];
  for (const it of issues.slice(0, limit)) {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: it.number,
      per_page: 100,
    });
    items.push({
      kind: it.pull_request ? "pr" : "issue",
      number: it.number,
      title: it.title,
      body: it.body ?? "",
      url: it.html_url,
      state: it.state,
      stateReason: it.state_reason ?? null,
      labels: it.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
      closedAt: it.closed_at,
      comments: comments.map((c) => c.body ?? "").filter(Boolean),
    });
  }
  return items;
}

/** Fetch a single issue/PR (with comments) for live ingestion. */
export async function fetchItem(installationId: number, repoFullName: string, number: number): Promise<RepoItem> {
  const octokit = await app.getInstallationOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");
  const { data: it } = await octokit.rest.issues.get({ owner, repo, issue_number: number });
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  return {
    kind: it.pull_request ? "pr" : "issue",
    number: it.number,
    title: it.title,
    body: it.body ?? "",
    url: it.html_url,
    state: it.state,
    stateReason: it.state_reason ?? null,
    labels: it.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    closedAt: it.closed_at,
    comments: comments.map((c) => c.body ?? "").filter(Boolean),
  };
}

export async function fetchPr(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<{ title: string; body: string; url: string; files: string[] }> {
  const octokit = await app.getInstallationOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return { title: pr.title, body: pr.body ?? "", url: pr.html_url, files: files.map((f) => f.filename) };
}

export async function postComment(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const octokit = await app.getInstallationOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");
  await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
}
