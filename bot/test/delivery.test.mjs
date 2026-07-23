process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const { buildIssueWarning, resolveDelivery } = await import("../dist/delivery.js");

let pass = 0;
let fail = 0;
const ok = (name, condition) => {
  if (condition) pass++;
  else fail++;
  console.log(`  ${condition ? "PASS" : "FAIL"} ${name}`);
};

const calls = {
  checkCreates: [],
  checkUpdates: [],
  commentCreates: [],
  commentUpdates: [],
};
let listedComments = [];
const deletedCommentIds = new Set();
let nextCheckId = 100;
let nextCommentId = 200;
const octokit = {
  rest: {
    checks: {
      create: async (input) => {
        calls.checkCreates.push(input);
        return { data: { id: nextCheckId++ } };
      },
      update: async (input) => {
        calls.checkUpdates.push(input);
        return { data: {} };
      },
    },
    issues: {
      listComments: async () => ({ data: listedComments }),
      createComment: async (input) => {
        calls.commentCreates.push(input);
        return { data: { id: nextCommentId++ } };
      },
      updateComment: async (input) => {
        if (deletedCommentIds.has(input.comment_id)) throw Object.assign(new Error("not found"), { status: 404 });
        calls.commentUpdates.push(input);
        return { data: {} };
      },
    },
  },
  paginate: async () => listedComments,
};
const ctx = {
  octokit,
  owner: "acme",
  repo: "app",
  number: 42,
  headSha: "head-1",
};
const decision = {
  blocking: true,
  findings: [{
    decisionId: "ISSUE-1",
    title: "Reject Redis",
    outcome: "rejected",
    sourceUrl: "https://github.com/acme/app/issues/1",
    summaryMd: "Redis was previously rejected because it adds operational overhead.",
    anchors: [{
      path: "proposal.md",
      side: "RIGHT",
      line: 3,
      level: "failure",
      message: "Re-proposes ISSUE-1",
    }],
  }],
};
const issueWarning = buildIssueWarning(
  {
    matches: true,
    decisionId: "PR-3",
    comment: "This proposal reintroduces RabbitMQ.",
  },
  {
    decisionId: "PR-3",
    installationId: 1,
    repo: "acme/app",
    sourceType: "pr",
    sourceUrl: "https://github.com/acme/app/pull/3",
    title: "Reject RabbitMQ for background jobs",
    outcome: "rejected",
    reasoningText: "The existing queue is sufficient.",
    decidedAt: "2026-07-23T00:00:00Z",
    terms: ["RabbitMQ"],
    createdAt: "2026-07-23T00:00:00Z",
  },
);
ok(
  "issue warning cites the decision and source",
  issueWarning?.includes("Decision: PR-3: Reject RabbitMQ") &&
    issueWarning.includes("https://github.com/acme/app/pull/3"),
);
ok(
  "issue warning rejects an empty judgment",
  buildIssueWarning({ matches: false, decisionId: null, comment: "" }, null) === null,
);

const delivery = resolveDelivery("check");
let refs = await delivery.open(ctx);
refs = await delivery.publish(ctx, refs, decision);
ok("check mode creates a blocking check", calls.checkUpdates[0]?.conclusion === "failure");
ok("new check receives the file annotation", calls.checkUpdates[0]?.output.annotations?.length === 1);
ok("check mode creates one summary comment", calls.commentCreates.length === 1 && refs.commentId === 200);
ok("summary comment carries a stable marker", calls.commentCreates[0]?.body.startsWith("<!-- orin:decision-summary -->"));
ok("summary comment cites the rejected decision", calls.commentCreates[0]?.body.includes("ISSUE-1") && calls.commentCreates[0]?.body.includes("/issues/1"));

refs = await delivery.publish(ctx, refs, decision);
ok("same-head rerun reuses the comment", calls.commentCreates.length === 1 && calls.commentUpdates.at(-1)?.comment_id === 200);
ok("same-head rerun does not append duplicate annotations", !("annotations" in calls.checkUpdates[1].output));

await delivery.clear(ctx, refs);
ok("clearing a conflict resolves the existing comment", calls.commentUpdates.at(-1)?.comment_id === 200 && calls.commentUpdates.at(-1)?.body.includes("no decision conflict"));

listedComments = [{
  id: 302,
  body: "<!-- orin:decision-summary -->\nforeign marker",
  performed_via_github_app: { id: 999 },
}];
const foreignMarker = await delivery.publish(ctx, { mode: "check", checkRunId: 101 }, decision);
ok("foreign marker cannot hijack Orin comment updates", foreignMarker.commentId === 201 && calls.commentCreates.length === 2);

listedComments = [];
deletedCommentIds.add(404);
const replaced = await delivery.publish(ctx, { mode: "check", checkRunId: 101, commentId: 404 }, decision);
ok("deleted stored comment is recreated", replaced.commentId === 202 && calls.commentCreates.length === 3);
const clearedDeleted = await delivery.clear(ctx, { mode: "check", checkRunId: 101, commentId: 404 });
ok("clearing a deleted comment does not fail the check", clearedDeleted.commentId === undefined);

listedComments = [{
  id: 303,
  body: "<!-- orin:decision-summary -->\nold finding",
  performed_via_github_app: { id: 1 },
}];
const recovered = await delivery.publish(ctx, { mode: "check", checkRunId: 101 }, decision);
ok("marker recovery reuses Orin comment missing from persistence", recovered.commentId === 303 && calls.commentCreates.length === 3);

listedComments = [];
const cleanRefs = await delivery.open({ ...ctx, headSha: "head-2" });
const createsBeforeClean = calls.commentCreates.length;
const updatesBeforeClean = calls.commentUpdates.length;
await delivery.clear({ ...ctx, headSha: "head-2" }, cleanRefs);
ok("a clean PR without an old warning gets no comment", calls.commentCreates.length === createsBeforeClean && calls.commentUpdates.length === updatesBeforeClean);

console.log(`\n=== delivery.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
