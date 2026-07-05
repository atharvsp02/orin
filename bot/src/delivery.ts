import * as db from "./db.js";
import { anchorFor, suggestionBlock } from "./patch.js";
import type { installationOctokit } from "./github.js";
import type { Judgment } from "./llm.js";
import type { DeliveryDecision, DeliveryMode, Finding, Installation, PrSnapshot, TenantConfig } from "./types.js";

type Gh = Awaited<ReturnType<typeof installationOctokit>>;

export interface DeliveryCtx {
  octokit: Gh;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  detailsUrl?: string;
  externalId?: string;
}
export interface DeliveryRefs {
  mode: DeliveryMode;
  checkRunId?: number;
  reviewId?: number;
  commentId?: number;
}
export interface Delivery {
  mode: DeliveryMode;
  open(ctx: DeliveryCtx): Promise<DeliveryRefs>;
  publish(ctx: DeliveryCtx, prior: DeliveryRefs | null, d: DeliveryDecision): Promise<DeliveryRefs>;
  clear(ctx: DeliveryCtx, prior: DeliveryRefs | null): Promise<DeliveryRefs>;
}

const CHECK_NAME = "Orin"; // the required-status-check "context"

function output(findings: Finding[], notes?: string[]) {
  const f = findings[0];
  const rules = notes?.length ? `\n\n---\n\n**Related coding rules**\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
  return {
    title: f ? `Re-proposes ${f.decisionId} (${f.outcome})` : "No decision conflict",
    summary: f ? (f.summaryMd.split("\n")[0] ?? "") : "No re-proposal of a rejected decision found.",
    text:
      findings.map((x) => `### ${x.decisionId} — ${x.title}\n\n${x.summaryMd}\n\nSource: ${x.sourceUrl}`).join("\n\n---\n\n") +
      rules,
  };
}

function annotations(findings: Finding[]) {
  return findings.flatMap((f) =>
    f.anchors.map((a) => ({
      path: a.path,
      start_line: a.startLine ?? a.line,
      end_line: a.line,
      annotation_level: a.level,
      title: `Re-proposal of ${f.decisionId}`,
      message: a.message,
    })),
  );
}

async function openCheck(ctx: DeliveryCtx): Promise<number> {
  const { data } = await ctx.octokit.rest.checks.create({
    owner: ctx.owner,
    repo: ctx.repo,
    name: CHECK_NAME,
    head_sha: ctx.headSha,
    status: "in_progress",
    details_url: ctx.detailsUrl,
    external_id: ctx.externalId,
  });
  return data.id;
}

// Check Run — the enforcement surface (a required status check blocks merge on `failure`).
const checkDelivery: Delivery = {
  mode: "check",
  async open(ctx) {
    return { mode: "check", checkRunId: await openCheck(ctx) };
  },
  async publish(ctx, prior, d) {
    const id = prior?.checkRunId ?? (await openCheck(ctx));
    const o = output(d.findings, d.notes);
    await ctx.octokit.rest.checks.update({
      owner: ctx.owner,
      repo: ctx.repo,
      check_run_id: id,
      status: "completed",
      conclusion: d.blocking ? "failure" : "neutral",
      output: { title: o.title, summary: o.summary, text: o.text, annotations: annotations(d.findings).slice(0, 50) },
    });
    return { mode: "check", checkRunId: id };
  },
  async clear(ctx, prior) {
    const id = prior?.checkRunId ?? (await openCheck(ctx));
    await ctx.octokit.rest.checks.update({
      owner: ctx.owner,
      repo: ctx.repo,
      check_run_id: id,
      status: "completed",
      conclusion: "success",
      output: { title: "No decision conflict", summary: "No re-proposal of a rejected decision found." },
    });
    return { mode: "check", checkRunId: id };
  },
};

// Inline review — the UX surface (anchored comments + suggested changes).
const reviewDelivery: Delivery = {
  mode: "review",
  async open() {
    return { mode: "review" };
  },
  async publish(ctx, prior, d) {
    if (prior?.reviewId) {
      await ctx.octokit.rest.pulls
        .dismissReview({ owner: ctx.owner, repo: ctx.repo, pull_number: ctx.number, review_id: prior.reviewId, message: "superseded by a newer commit" })
        .catch(() => undefined);
    }
    const comments = d.findings.flatMap((f) =>
      f.anchors.map((a) => ({
        path: a.path,
        ...(a.startLine ? { start_line: a.startLine, start_side: a.side } : {}),
        line: a.line,
        side: a.side,
        body: a.suggestion ? `${a.message}\n\n${suggestionBlock(a.suggestion)}` : a.message,
      })),
    );
    const { data } = await ctx.octokit.rest.pulls.createReview({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.number,
      commit_id: ctx.headSha,
      event: d.blocking ? "REQUEST_CHANGES" : "COMMENT",
      body: output(d.findings).summary,
      comments,
    });
    return { mode: "review", reviewId: data.id };
  },
  async clear(ctx, prior) {
    if (prior?.reviewId) {
      await ctx.octokit.rest.pulls
        .dismissReview({ owner: ctx.owner, repo: ctx.repo, pull_number: ctx.number, review_id: prior.reviewId, message: "resolved on a newer commit" })
        .catch(() => undefined);
    }
    return { mode: "review" };
  },
};

// Issue comment — the fallback (idempotent update).
const commentDelivery: Delivery = {
  mode: "comment",
  async open() {
    return { mode: "comment" };
  },
  async publish(ctx, prior, d) {
    const body = output(d.findings, d.notes).text;
    if (prior?.commentId) {
      await ctx.octokit.rest.issues.updateComment({ owner: ctx.owner, repo: ctx.repo, comment_id: prior.commentId, body });
      return { mode: "comment", commentId: prior.commentId };
    }
    const { data } = await ctx.octokit.rest.issues.createComment({ owner: ctx.owner, repo: ctx.repo, issue_number: ctx.number, body });
    return { mode: "comment", commentId: data.id };
  },
  async clear(ctx, prior) {
    if (prior?.commentId) {
      await ctx.octokit.rest.issues
        .updateComment({ owner: ctx.owner, repo: ctx.repo, comment_id: prior.commentId, body: "✅ Orin: no decision conflict on the latest commit." })
        .catch(() => undefined);
    }
    return { mode: "comment", commentId: prior?.commentId };
  },
};

export function resolveDelivery(mode: DeliveryMode): Delivery {
  return mode === "review" ? reviewDelivery : mode === "comment" ? commentDelivery : checkDelivery;
}

/** Turn a judgment + PR into a delivery decision (with an inline anchor when terms overlap the diff). */
export async function buildDecision(
  inst: Installation,
  cfg: TenantConfig,
  repo: string,
  pr: PrSnapshot,
  judgment: Judgment,
  rules: string[] = [],
): Promise<DeliveryDecision> {
  if (!judgment.matches || !judgment.decisionId) return { blocking: false, findings: [] };
  const rec = await db.getDecisionRecord(inst.installationId, repo, judgment.decisionId);
  const blocking = cfg.blockOnRepropose && !pr.draft;
  const anchor = rec
    ? anchorFor(pr.files, rec.terms, {
        level: blocking ? "failure" : "warning",
        message: `Re-proposes ${judgment.decisionId} (rejected): ${rec.reasoningText}`.slice(0, 400),
      })
    : null;
  return {
    blocking,
    notes: rules.length ? rules : undefined,
    findings: [
      {
        decisionId: judgment.decisionId,
        title: rec?.title ?? judgment.decisionId,
        outcome: rec?.outcome ?? "rejected",
        sourceUrl: rec?.sourceUrl ?? "",
        summaryMd: judgment.comment,
        anchors: anchor ? [anchor] : [],
      },
    ],
  };
}
