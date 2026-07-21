import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const {
  GoogleDriveClient,
  GoogleDriveApiError,
  decodeDriveState,
  drivePermissionAcl,
  encodeDriveState,
  googleDriveExportMimeType,
} = await import("../dist/google-drive.js");

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

console.log("Google Drive connector");

await test("roundtrips signed OAuth state", () => {
  const state = {
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    userId: "123e4567-e89b-12d3-a456-426614174001",
    expiresAt: Date.now() + 60_000,
    nonce: "1234567890abcdef",
  };
  assert.deepEqual(decodeDriveState(encodeDriveState(state)), state);
});

await test("rejects tampered and expired OAuth state", () => {
  const valid = encodeDriveState({
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    userId: "123e4567-e89b-12d3-a456-426614174001",
    expiresAt: Date.now() + 60_000,
    nonce: "1234567890abcdef",
  });
  assert.equal(decodeDriveState(`${valid}x`), null);
  assert.equal(decodeDriveState(encodeDriveState({
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    userId: "123e4567-e89b-12d3-a456-426614174001",
    expiresAt: Date.now() - 1,
    nonce: "1234567890abcdef",
  })), null);
});

await test("maps native file export formats", () => {
  assert.equal(googleDriveExportMimeType("application/vnd.google-apps.document"), "text/plain");
  assert.equal(googleDriveExportMimeType("application/vnd.google-apps.spreadsheet"), "text/csv");
  assert.equal(googleDriveExportMimeType("application/pdf"), null);
});

await test("maps Drive permission principals", () => {
  assert.deepEqual(drivePermissionAcl({ type: "user", emailAddress: "USER@example.com" }), {
    principalType: "email",
    principalKey: "USER@example.com",
  });
  assert.deepEqual(drivePermissionAcl({ type: "group", emailAddress: "team@example.com" }), {
    principalType: "external_group",
    principalKey: "team@example.com",
  });
  assert.deepEqual(drivePermissionAcl({ type: "domain", domain: "example.com", allowFileDiscovery: true }), {
    principalType: "domain",
    principalKey: "example.com",
  });
  assert.deepEqual(drivePermissionAcl({ type: "anyone", allowFileDiscovery: true }), { principalType: "anyone", principalKey: "*" });
  assert.equal(drivePermissionAcl({ type: "anyone", allowFileDiscovery: false }), null);
  assert.equal(drivePermissionAcl({ type: "domain", domain: "example.com", allowFileDiscovery: false }), null);
  assert.equal(drivePermissionAcl({ type: "domain" }), null);
});

await test("paginates shared drives with bearer authorization", async () => {
  const requests = [];
  const client = new GoogleDriveClient("access-token", async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, authorization: init?.headers?.Authorization });
    return Response.json(url.searchParams.get("pageToken")
      ? { drives: [{ id: "d2", name: "Product" }] }
      : { nextPageToken: "next", drives: [{ id: "d1", name: "Engineering" }] });
  });
  assert.deepEqual(await client.listAllDrives(), [
    { id: "d1", name: "Engineering" },
    { id: "d2", name: "Product" },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].authorization, "Bearer access-token");
});

await test("requests permission discovery fields across pages", async () => {
  const requests = [];
  const client = new GoogleDriveClient("access-token", async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    return Response.json(url.searchParams.get("pageToken")
      ? { permissions: [{ id: "p2", type: "user", emailAddress: "user@example.com" }] }
      : { nextPageToken: "next", permissions: [{ id: "p1", type: "anyone", allowFileDiscovery: false }] });
  });
  assert.equal((await client.listPermissions("file-1")).length, 2);
  assert.equal(requests.length, 2);
  assert.match(requests[0].searchParams.get("fields") ?? "", /allowFileDiscovery/);
  assert.equal(requests[1].searchParams.get("pageToken"), "next");
});

await test("downloads text and rejects oversized metadata", async () => {
  const client = new GoogleDriveClient("token", async () => new Response("architecture decision"));
  assert.equal(await client.downloadText({ id: "1", name: "Decision", mimeType: "text/plain", size: "21" }), "architecture decision");
  assert.equal(await client.downloadText({ id: "2", name: "Huge", mimeType: "text/plain", size: "2000001" }), null);
  assert.equal(await client.downloadText({ id: "3", name: "Image", mimeType: "image/png", size: "10" }), null);
});

await test("preserves Google API status for expired change cursors", async () => {
  const client = new GoogleDriveClient("token", async () => new Response("expired", { status: 410 }));
  await assert.rejects(() => client.listChanges("expired-cursor"), (error) => {
    assert.ok(error instanceof GoogleDriveApiError);
    assert.equal(error.status, 410);
    return true;
  });
});

console.log(`${passed} Google Drive connector checks passed`);
