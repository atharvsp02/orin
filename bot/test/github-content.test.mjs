import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const {
  githubDecisionBody,
  githubDecisionExternalId,
  githubRepositoryAcls,
} = await import("../dist/github-content.js");
const { searchTerms, searchTsQuery } = await import("../dist/content-db.js");

const record = {
  decisionId: "ISSUE-18",
  installationId: 42,
  repo: "acme/api",
  sourceType: "issue",
  sourceUrl: "https://github.com/acme/api/issues/18",
  title: "Keep PostgreSQL caching",
  outcome: "rejected",
  reasoningText: "Redis added deployment complexity without enough benefit.",
  decidedAt: "2026-07-20T10:00:00Z",
  terms: ["redis", "cache"],
  supersededBy: "PR-21",
  createdAt: "",
};

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

console.log("GitHub decision content");

test("uses a repository-scoped stable external id", () => {
  assert.equal(githubDecisionExternalId(record), "decision:acme/api:ISSUE-18");
  assert.notEqual(
    githubDecisionExternalId(record),
    githubDecisionExternalId({ repo: "acme/web", decisionId: "ISSUE-18" }),
  );
});

test("indexes the decision outcome, reasoning, terms, and supersession", () => {
  const body = githubDecisionBody(record);
  assert.match(body, /Outcome: rejected/);
  assert.match(body, /Reasoning: Redis added deployment complexity/);
  assert.match(body, /Key terms: redis, cache/);
  assert.match(body, /Superseded by: PR-21/);
});

test("grants workspace members access to public repository evidence", () => {
  assert.deepEqual(githubRepositoryAcls("public", false, [{ login: "ignored" }]), [
    { principalType: "anyone", principalKey: "*" },
  ]);
  assert.deepEqual(githubRepositoryAcls(undefined, false, []), [
    { principalType: "anyone", principalKey: "*" },
  ]);
});

test("uses normalized effective collaborators for restricted repositories", () => {
  assert.deepEqual(githubRepositoryAcls("private", true, [
    { login: "Owner" },
    { login: "reviewer" },
    { login: "OWNER" },
    { login: " " },
    {},
  ]), [
    { principalType: "github_login", principalKey: "owner" },
    { principalType: "github_login", principalKey: "reviewer" },
  ]);
  assert.deepEqual(githubRepositoryAcls("internal", true, []), []);
});

test("builds a safe broad query from meaningful unique terms", () => {
  assert.equal(
    searchTsQuery("Why did we reject Redis addition? Redis was discussed."),
    "reject | redis | addition | discussed",
  );
  assert.deepEqual(searchTerms("Why did we reject Redis addition? Redis was discussed."), [
    "reject", "redis", "addition", "discussed",
  ]);
  assert.equal(searchTsQuery("% () !"), "");
  assert.equal(searchTsQuery("alpha ".repeat(40)).split(" | ").length, 1);
});

console.log(`${passed} GitHub decision content checks passed`);
