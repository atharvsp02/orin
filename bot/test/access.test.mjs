import assert from "node:assert/strict";

const {
  can,
  canPotentially,
  canAccessContent,
  isWorkspacePermission,
  isWorkspaceRole,
  matchesConditions,
  normalizePrincipal,
} = await import("../dist/access.js");

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

console.log("workspace access");

test("validates roles and permissions", () => {
  assert.equal(isWorkspaceRole("owner"), true);
  assert.equal(isWorkspaceRole("root"), false);
  assert.equal(isWorkspacePermission("search.use"), true);
  assert.equal(isWorkspacePermission("search.admin"), false);
});

test("assigns role defaults", () => {
  assert.equal(can("owner", "people.manage"), true);
  assert.equal(can("admin", "audit.read"), true);
  assert.equal(can("member", "chat.use"), true);
  assert.equal(can("member", "people.manage"), false);
  assert.equal(can("viewer", "search.use"), true);
  assert.equal(can("viewer", "chat.use"), false);
});

test("allows a feature grant", () => {
  assert.equal(can("viewer", "chat.use", [{ permission: "chat.use", effect: "allow" }]), true);
});

test("deny takes precedence over allow and role", () => {
  const grants = [
    { permission: "search.use", effect: "allow" },
    { permission: "search.use", effect: "deny" },
  ];
  assert.equal(can("owner", "search.use", grants), false);
});

test("applies conditional grants only in matching context", () => {
  const grants = [{
    permission: "chat.use",
    effect: "allow",
    conditions: { connectorProvider: ["slack", "linear"], sourceType: "message" },
  }];
  assert.equal(can("viewer", "chat.use", grants, { connectorProvider: "Slack", sourceType: "message" }), true);
  assert.equal(can("viewer", "chat.use", grants, { connectorProvider: "github", sourceType: "message" }), false);
  assert.equal(can("viewer", "chat.use", grants, { connectorProvider: "slack" }), false);
});

test("recognizes conditional and universal feature availability", () => {
  const conditionalAllow = [{ permission: "chat.use", effect: "allow", conditions: { connectorProvider: "slack" } }];
  assert.equal(canPotentially("viewer", "chat.use", conditionalAllow), true);
  assert.equal(canPotentially("viewer", "chat.use"), false);
  assert.equal(canPotentially("member", "search.use", [{
    permission: "search.use",
    effect: "deny",
    conditions: { connectorProvider: "gdrive" },
  }]), true);
  assert.equal(canPotentially("owner", "search.use", [{ permission: "search.use", effect: "deny" }]), false);
});

test("rejects unknown condition keys", () => {
  assert.equal(matchesConditions({ department: "engineering" }, {}), false);
});

test("normalizes source principals", () => {
  assert.equal(normalizePrincipal("Email", " USER@Example.com "), "email:user@example.com");
  assert.throws(() => normalizePrincipal("", "x"));
  assert.throws(() => normalizePrincipal("email", ""));
});

test("allows workspace-visible content", () => {
  assert.equal(canAccessContent(
    { visibility: "workspace", aclStatus: "failed", aclPrincipals: [] },
    new Set(),
  ), true);
});

test("matches current restricted ACL principals", () => {
  assert.equal(canAccessContent(
    { visibility: "restricted", aclStatus: "current", aclPrincipals: ["email:user@example.com"] },
    new Set(["email:user@example.com"]),
  ), true);
  assert.equal(canAccessContent(
    { visibility: "restricted", aclStatus: "current", aclPrincipals: ["group:finance"] },
    new Set(["email:user@example.com"]),
  ), false);
});

test("fails closed for stale, failed, and empty ACLs", () => {
  const principals = new Set(["email:user@example.com"]);
  assert.equal(canAccessContent(
    { visibility: "restricted", aclStatus: "stale", aclPrincipals: ["email:user@example.com"] },
    principals,
  ), false);
  assert.equal(canAccessContent(
    { visibility: "restricted", aclStatus: "failed", aclPrincipals: ["email:user@example.com"] },
    principals,
  ), false);
  assert.equal(canAccessContent(
    { visibility: "restricted", aclStatus: "current", aclPrincipals: [] },
    principals,
  ), false);
});

console.log(`${passed} workspace access checks passed`);
