import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";
process.env.GITHUB_OAUTH_CLIENT_ID ??= "github-client";
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= "github-secret";
process.env.SLACK_CLIENT_ID ??= "slack-client";
process.env.SLACK_CLIENT_SECRET ??= "slack-secret";
process.env.LINEAR_CLIENT_ID ??= "linear-client";
process.env.LINEAR_CLIENT_SECRET ??= "linear-secret";
delete process.env.WEB_ORIGIN;

const {
  checkOAuthState,
  fetchGitHubInstallations,
  handleAuthProviders,
  handleLinearAuthStart,
  handleSlackAuthStart,
  mintOAuthState,
  normalizeLinearViewerIdentity,
  normalizeSlackOpenIdIdentity,
  slackAdminEligible,
} = await import("../dist/auth.js");

class MockResponse {
  headers = new Map();
  status = 0;
  body = "";

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  writeHead(status, headers = {}) {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }

  end(body = "") {
    this.body = String(body);
    return this;
  }
}

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

const issuedAt = 1_800_000_000_000;
const slackState = mintOAuthState("slack", "browser-nonce", issuedAt);
const slackRequest = { headers: { cookie: "orin_oauth_slack=browser-nonce" } };
assert.equal(checkOAuthState(slackRequest, slackState, "slack", issuedAt + 1_000), true);
assert.equal(checkOAuthState(slackRequest, slackState, "linear", issuedAt + 1_000), false);
assert.equal(checkOAuthState({ headers: { cookie: "orin_oauth_slack=foreign" } }, slackState, "slack", issuedAt + 1_000), false);
assert.equal(checkOAuthState(slackRequest, slackState, "slack", issuedAt + 15 * 60_000), false);
assert.equal(checkOAuthState(slackRequest, slackState, "slack", issuedAt - 1), false);

const request = { headers: { host: "127.0.0.1:3000" } };
const slackStart = new MockResponse();
handleSlackAuthStart(request, slackStart);
const slackAuthorize = new URL(slackStart.headers.get("location"));
assert.equal(slackStart.status, 302);
assert.equal(slackAuthorize.origin, "https://slack.com");
assert.equal(slackAuthorize.pathname, "/openid/connect/authorize");
assert.equal(slackAuthorize.searchParams.get("scope"), "openid profile email");
assert.equal(slackAuthorize.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/v1/auth/slack/callback");
assert.match(slackStart.headers.get("set-cookie"), /^orin_oauth_slack=/);
assert.doesNotMatch(slackStart.headers.get("set-cookie"), /; Secure/);

const secureSlackStart = new MockResponse();
handleSlackAuthStart({ headers: { host: "auth.example.com", "x-forwarded-proto": "https" } }, secureSlackStart);
assert.match(secureSlackStart.headers.get("set-cookie"), /; Secure/);

const linearStart = new MockResponse();
handleLinearAuthStart(request, linearStart);
const linearAuthorize = new URL(linearStart.headers.get("location"));
assert.equal(linearStart.status, 302);
assert.equal(linearAuthorize.origin, "https://linear.app");
assert.equal(linearAuthorize.searchParams.get("actor"), "user");
assert.equal(linearAuthorize.searchParams.get("scope"), "read");
assert.equal(linearAuthorize.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/v1/auth/linear/callback");
assert.equal(linearAuthorize.searchParams.get("code_challenge_method"), "S256");
assert.match(linearAuthorize.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);

const providerResponse = new MockResponse();
handleAuthProviders(providerResponse);
assert.equal(providerResponse.status, 200);
assert.deepEqual(JSON.parse(providerResponse.body), {
  providers: { github: true, slack: true, linear: true },
});

const slackProfile = {
  ok: true,
  email_verified: true,
  email: "OWNER@EXAMPLE.COM",
  name: "Workspace Owner",
  picture: "https://example.com/avatar.png",
  "https://slack.com/team_id": "T123",
  "https://slack.com/user_id": "U123",
};
const slackIdentity = normalizeSlackOpenIdIdentity(slackProfile);
assert.deepEqual(slackIdentity, {
  teamId: "T123",
  userId: "U123",
  name: "Workspace Owner",
  email: "owner@example.com",
  picture: "https://example.com/avatar.png",
});
assert.equal(normalizeSlackOpenIdIdentity({ ...slackProfile, email_verified: false }), null);
assert.equal(slackAdminEligible({
  ok: true,
  user: {
    id: "U123",
    is_admin: true,
    profile: { email: "owner@example.com" },
  },
}, "U123", "owner@example.com"), true);
assert.equal(slackAdminEligible({
  ok: true,
  user: {
    id: "U123",
    is_admin: false,
    profile: { email: "owner@example.com" },
  },
}, "U123", "owner@example.com"), false);

assert.deepEqual(normalizeLinearViewerIdentity({
  data: {
    viewer: {
      id: "linear-user",
      name: "Linear Owner",
      email: "OWNER@EXAMPLE.COM",
      avatarUrl: "https://example.com/linear.png",
      active: true,
      app: false,
      admin: true,
      owner: false,
      organization: { id: "linear-org", name: "Acme" },
    },
  },
}), {
  organizationId: "linear-org",
  organizationName: "Acme",
  userId: "linear-user",
  name: "Linear Owner",
  email: "owner@example.com",
  avatarUrl: "https://example.com/linear.png",
  admin: true,
  owner: false,
});
assert.equal(normalizeLinearViewerIdentity({
  data: {
    viewer: {
      id: "app-user",
      email: "app@example.com",
      active: true,
      app: true,
      organization: { id: "linear-org" },
    },
  },
}), null);

console.log("provider authentication checks passed");
