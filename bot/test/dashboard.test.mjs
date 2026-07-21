import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const { dashboardPermission, isDashboardEntityId, parseDashboardPath } = await import("../dist/dash.js");
const { githubInstallationBootstrapEligible, originsMatch } = await import("../dist/auth.js");

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

test("validates dashboard entity ids", () => {
  assert.equal(isDashboardEntityId("123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isDashboardEntityId(""), false);
  assert.equal(isDashboardEntityId("not-a-uuid"), false);
});

test("maps member resources to feature permissions", () => {
  assert.equal(dashboardPermission("overview", "GET"), "workspace.read");
  assert.equal(dashboardPermission("search", "POST"), "search.use");
  assert.equal(dashboardPermission("chat", "POST"), "chat.use");
  assert.equal(dashboardPermission("connectors", "GET"), "connectors.read");
});

test("maps administrative mutations to management permissions", () => {
  assert.equal(dashboardPermission("connectors", "PUT"), "connectors.manage");
  assert.equal(dashboardPermission("docs", "POST"), "content.manage");
  assert.equal(dashboardPermission("people", "GET"), "people.manage");
  assert.equal(dashboardPermission("audit", "GET"), "audit.read");
  assert.equal(dashboardPermission("syncs", "POST"), "connectors.manage");
  assert.equal(dashboardPermission("connectorpolicies", "POST"), "policies.manage");
});

test("compares mutation origins exactly", () => {
  assert.equal(originsMatch("https://orin.example", "https://orin.example/dashboard"), true);
  assert.equal(originsMatch("https://evil.example", "https://orin.example"), false);
  assert.equal(originsMatch("https://orin.example.evil.test", "https://orin.example"), false);
  assert.equal(originsMatch("not a url", "https://orin.example"), false);
});

test("bootstraps only GitHub installation owners", () => {
  const user = { id: 7, login: "owner" };
  assert.equal(githubInstallationBootstrapEligible({
    id: 1,
    app_id: 1,
    target_type: "User",
    account: { id: 7, login: "owner", type: "User" },
  }, user), true);
  assert.equal(githubInstallationBootstrapEligible({
    id: 2,
    app_id: 1,
    target_type: "Organization",
    account: { id: 8, login: "acme", type: "Organization" },
  }, user, { state: "active", role: "admin" }), true);
  assert.equal(githubInstallationBootstrapEligible({
    id: 2,
    app_id: 1,
    target_type: "Organization",
    account: { id: 8, login: "acme", type: "Organization" },
  }, user, { state: "active", role: "member" }), false);
  assert.equal(githubInstallationBootstrapEligible({
    id: 3,
    app_id: 1,
    target_type: "User",
    account: { id: 99, login: "someone-else", type: "User" },
  }, user), false);
});

console.log(`${passed} dashboard route checks passed`);
