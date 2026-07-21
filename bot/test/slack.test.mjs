import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const { normalizeSlackMessage, slackInstallerEligible, slackMembershipAcls } = await import("../dist/slack.js");

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

console.log("Slack content connector");

test("normalizes a new human message", () => {
  assert.deepEqual(normalizeSlackMessage({
    type: "message",
    channel: "C123",
    ts: "1720000000.000100",
    thread_ts: "1720000000.000001",
    user: "U123",
    text: "  Keep the deployment decision  ",
  }), {
    kind: "upsert",
    channelId: "C123",
    timestamp: "1720000000.000100",
    text: "Keep the deployment decision",
    userId: "U123",
    threadTimestamp: "1720000000.000001",
  });
});

test("normalizes message edits and deletions", () => {
  assert.deepEqual(normalizeSlackMessage({
    type: "message",
    subtype: "message_changed",
    channel: "C123",
    message: { ts: "1720000000.000100", user: "U123", text: "Updated decision" },
  })?.text, "Updated decision");
  assert.deepEqual(normalizeSlackMessage({
    type: "message",
    subtype: "message_deleted",
    channel: "C123",
    deleted_ts: "1720000000.000100",
  }), {
    kind: "delete",
    channelId: "C123",
    timestamp: "1720000000.000100",
  });
});

test("ignores bots and malformed events", () => {
  assert.equal(normalizeSlackMessage({ channel: "C123", ts: "bad", user: "U123", text: "text" }), null);
  assert.equal(normalizeSlackMessage({ channel: "C123", ts: "1720000000.1", bot_id: "B123", text: "text" }), null);
  assert.equal(normalizeSlackMessage({ channel: "C123", ts: "1720000000.1", user: "U123", text: " " }), null);
});

test("builds deduplicated workspace-scoped Slack user principals", () => {
  assert.deepEqual(slackMembershipAcls("T1", ["U1", "U1", "U2", ""]), [
    { principalType: "slack_user", principalKey: "T1:U1" },
    { principalType: "slack_user", principalKey: "T1:U2" },
  ]);
});

test("bootstraps only a current human Slack administrator", () => {
  assert.equal(slackInstallerEligible({ is_admin: true }), true);
  assert.equal(slackInstallerEligible({ is_owner: true }), true);
  assert.equal(slackInstallerEligible({ is_admin: true, deleted: true }), false);
  assert.equal(slackInstallerEligible({ is_admin: true, is_bot: true }), false);
  assert.equal(slackInstallerEligible({}), false);
});

console.log(`${passed} Slack connector checks passed`);
