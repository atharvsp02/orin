import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const { parseDashboardPath } = await import("../dist/dash.js");

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
};

console.log("dashboard routes");

test("parses a workspace route", () => {
  assert.deepEqual(parseDashboardPath("/v1/workspaces/123E4567-E89B-12D3-A456-426614174000/overview"), {
    kind: "workspace",
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    resource: "overview",
    sub: undefined,
  });
});

test("parses a workspace subresource", () => {
  assert.deepEqual(parseDashboardPath("/v1/workspaces/123e4567-e89b-12d3-a456-426614174000/keys/key_1"), {
    kind: "workspace",
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    resource: "keys",
    sub: "key_1",
  });
});

test("keeps legacy installation routes", () => {
  assert.deepEqual(parseDashboardPath("/v1/dash/42/decisions"), {
    kind: "installation",
    installationId: 42,
    resource: "decisions",
    sub: undefined,
  });
});

test("rejects an invalid workspace id", () => {
  assert.equal(parseDashboardPath("/v1/workspaces/not-a-uuid/overview"), null);
});

test("rejects missing resources", () => {
  assert.equal(parseDashboardPath("/v1/workspaces/123e4567-e89b-12d3-a456-426614174000"), null);
  assert.equal(parseDashboardPath("/v1/dash/42"), null);
});

test("rejects invalid installation boundaries", () => {
  assert.equal(parseDashboardPath("/v1/dash/0/overview"), null);
  assert.equal(parseDashboardPath("/v1/dash/9007199254740992/overview"), null);
});

console.log(`${passed} dashboard route checks passed`);
