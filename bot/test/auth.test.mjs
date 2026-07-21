import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const { fetchGitHubInstallations } = await import("../dist/auth.js");

const requests = [];
const installations = await fetchGitHubInstallations({ Authorization: "Bearer token" }, async (input) => {
  const url = String(input);
  requests.push(url);
  if (requests.length === 1) {
    return Response.json({ installations: [{ id: 1, app_id: 1 }] }, {
      headers: { link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"' },
    });
  }
  return Response.json({ installations: [{ id: 2, app_id: 1 }] });
});
assert.deepEqual(installations?.map((installation) => installation.id), [1, 2]);
assert.equal(requests.length, 2);

const rejected = await fetchGitHubInstallations({}, async () => new Response("denied", { status: 403 }));
assert.equal(rejected, null);

const invalidNext = await fetchGitHubInstallations({}, async () => Response.json({ installations: [] }, {
  headers: { link: '<https://example.com/user/installations?page=2>; rel="next"' },
}));
assert.equal(invalidNext, null);

console.log("3 GitHub authentication pagination checks passed");
