import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const {
  checkLinearInstallState,
  linearAdministrator,
  linearInlineAnswerAllowed,
  linearInstallCodeChallenge,
  linearInstallCodeVerifier,
  mintLinearInstallState,
  verifyLinearWebhook,
} = await import("../dist/linear.js");
const { linearTeamMembershipAcls, linearUserAcl } = await import("../dist/linear-content.js");

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

const human = (id, extra = {}) => ({ id, name: id, active: true, app: false, ...extra });

console.log("Linear content connector");

await test("maps only active human users to organization-scoped principals", () => {
  assert.deepEqual(linearUserAcl("org-1", human("user-1")), {
    principalType: "linear_user",
    principalKey: "org-1:user-1",
  });
  assert.equal(linearUserAcl("org-1", human("inactive", { active: false })), null);
  assert.equal(linearUserAcl("org-1", human("app", { app: true })), null);
});

await test("grants public team access to public workspace users and explicit members", () => {
  const publicUser = human("public", { canAccessAnyPublicTeam: true });
  const guest = human("guest", { guest: true, canAccessAnyPublicTeam: false });
  const inactive = human("inactive", { active: false, canAccessAnyPublicTeam: true });
  assert.deepEqual(linearTeamMembershipAcls(
    "org-1",
    { visibility: "public" },
    [publicUser, inactive],
    [guest, publicUser],
  ), [
    { principalType: "linear_user", principalKey: "org-1:public" },
    { principalType: "linear_user", principalKey: "org-1:guest" },
  ]);
});

await test("limits private and restricted teams to current team members", () => {
  const outsider = human("outsider", { canAccessAnyPublicTeam: true });
  const member = human("member");
  const app = human("app", { app: true });
  for (const visibility of ["private", "restricted"]) {
    assert.deepEqual(linearTeamMembershipAcls(
      "org-1",
      { visibility },
      [outsider],
      [member, app],
    ), [{ principalType: "linear_user", principalKey: "org-1:member" }]);
  }
});

await test("binds install state to the browser nonce and time window", () => {
  const secret = "state-secret";
  const now = 1_800_000_000_000;
  const state = mintLinearInstallState(secret, "browser-nonce", now);
  assert.equal(checkLinearInstallState(secret, state, "browser-nonce", now + 1_000), true);
  assert.equal(checkLinearInstallState(secret, state, "other-browser", now + 1_000), false);
  assert.equal(checkLinearInstallState(secret, `${state}x`, "browser-nonce", now + 1_000), false);
  assert.equal(checkLinearInstallState(secret, state, "browser-nonce", now + 15 * 60_000 + 1), false);
  assert.equal(checkLinearInstallState(secret, mintLinearInstallState(secret, "future", now + 60_001), "future", now), false);
});

await test("creates deterministic S256 PKCE values", () => {
  const verifier = linearInstallCodeVerifier("pkce-secret", "nonce");
  assert.equal(verifier.length, 43);
  assert.equal(
    linearInstallCodeChallenge("pkce-secret", "nonce"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
});

await test("accepts only authentic fresh webhook payloads", () => {
  const secret = "webhook-secret";
  const now = 1_800_000_000_000;
  const raw = JSON.stringify({ type: "Issue", webhookTimestamp: now });
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(verifyLinearWebhook(secret, raw, signature, now), true);
  assert.equal(verifyLinearWebhook(secret, raw, `sha256=${signature}`, now), true);
  assert.equal(verifyLinearWebhook(secret, `${raw} `, signature, now), false);
  assert.equal(verifyLinearWebhook(secret, raw, signature, now + 60_001), false);
  assert.equal(verifyLinearWebhook(secret, JSON.stringify({ type: "Issue" }), signature, now), false);
});

await test("blocks inline answers when an issue has individual sharing", () => {
  assert.equal(linearInlineAnswerAllowed({ sharedAccess: { isShared: false } }), true);
  assert.equal(linearInlineAnswerAllowed({ sharedAccess: { isShared: true } }), false);
  assert.equal(linearInlineAnswerAllowed({}), true);
});

await test("allows link codes only for current human Linear administrators", () => {
  assert.equal(linearAdministrator({ active: true, app: false, admin: true }), true);
  assert.equal(linearAdministrator({ active: true, app: false, owner: true }), true);
  assert.equal(linearAdministrator({ active: false, app: false, admin: true }), false);
  assert.equal(linearAdministrator({ active: true, app: true, admin: true }), false);
  assert.equal(linearAdministrator({ active: true, app: false }), false);
});

console.log(`${passed} Linear connector checks passed`);
