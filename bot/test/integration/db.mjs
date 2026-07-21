// End-to-end DB-layer integration test against a REAL Postgres. Exercises every function the
// session added/changed. Run with DATABASE_URL pointed at the local cluster.
process.env.ORIN_SECRET ??= "integration-secret-please-rotate-000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const BOT = new URL("../../dist/", import.meta.url).href;
const db = await import(`${BOT}db.js`);
const enterprise = await import(`${BOT}enterprise-db.js`);
const contentDb = await import(`${BOT}content-db.js`);
const { Pool } = await import("pg");
const sql = new Pool({ connectionString: process.env.DATABASE_URL });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : `  ${extra}`}`);
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

await db.initSchema();
console.log("schema: initialized");

// --- installations + crypto roundtrip ---
const INST = 900001;
await db.upsertInstallation({ installationId: INST, githubAccount: "acme", datasetName: `repo-${INST}`, cogneeApiKey: "SECRET-API-KEY-xyz" });
const inst = await db.getInstallation(INST);
ok("installation stored", inst?.installationId === INST);
eq("cognee key decrypts back to plaintext (crypto roundtrip)", inst?.cogneeApiKey, "SECRET-API-KEY-xyz");
let workspace = await db.getWorkspaceByInstallation(INST);
ok("installation creates a workspace", Boolean(workspace?.workspaceId));
ok("workspace retains its compatibility installation", workspace?.legacyInstallationId === INST);
eq("workspace decrypts the shared Cognee key", workspace?.cogneeApiKey, "SECRET-API-KEY-xyz");
const originalWorkspaceId = workspace?.workspaceId;
await sql.query(`DELETE FROM workspaces WHERE legacy_installation_id = $1`, [INST]);
ok("legacy workspace can be absent before migration", (await db.getWorkspaceByInstallation(INST)) === null);
await db.initSchema();
workspace = await db.getWorkspaceByInstallation(INST);
ok("schema migration backfills the legacy workspace", workspace?.workspaceId === originalWorkspaceId);
const githubConnector = await db.getConnector("github", String(INST));
ok(
  "schema migration backfills the GitHub connector",
  githubConnector?.workspaceId === workspace?.workspaceId && githubConnector.capabilities.length === 5,
);

// --- provider-neutral identity, membership, groups, grants, and audit ---
const ownerUser = await enterprise.upsertUserIdentity({
  provider: "github",
  externalId: "101",
  handle: "owner",
  displayName: "Workspace Owner",
  email: "owner@example.com",
  avatarUrl: "https://example.com/owner.png",
});
const ownerAlias = await enterprise.upsertUserIdentity({
  provider: "email",
  externalId: "owner@example.com",
  displayName: "Workspace Owner",
  email: "OWNER@example.com",
});
ok("identity aliases merge by normalized email", ownerAlias.userId === ownerUser.userId);
await enterprise.addUserIdentity(ownerUser.userId, {
  provider: "github_login",
  externalId: "owner",
  handle: "owner",
});
ok("identity lookup resolves the same user", (await enterprise.getUserByIdentity("github_login", "owner"))?.userId === ownerUser.userId);
const ownerMembership = await enterprise.bootstrapWorkspaceMembership(ownerUser.userId, workspace.workspaceId);
ok("first workspace member becomes owner", ownerMembership.role === "owner");
const adminUser = await enterprise.upsertUserIdentity({
  provider: "github",
  externalId: "102",
  handle: "admin",
  displayName: "Workspace Admin",
  email: "admin@example.com",
});
const adminMembership = await enterprise.bootstrapWorkspaceMembership(adminUser.userId, workspace.workspaceId);
ok("later GitHub administrator becomes admin", adminMembership.role === "admin");
const viewerMembership = await enterprise.inviteWorkspaceMember({
  workspaceId: workspace.workspaceId,
  email: "viewer@example.com",
  displayName: "Workspace Viewer",
  role: "viewer",
});
ok("email invitation creates viewer membership", viewerMembership.role === "viewer");
eq("active owner count", await enterprise.countActiveOwners(workspace.workspaceId), 1);
ok("viewer receives default search access", await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "search.use"));
ok("viewer has no default chat access", !(await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "chat.use")));

const rolloutGroup = await enterprise.createGroup({
  workspaceId: workspace.workspaceId,
  displayName: "AI rollout",
  externalId: "drive-group:ai-rollout@example.com",
});
await enterprise.replaceGroupMembers(workspace.workspaceId, rolloutGroup.groupId, [viewerMembership.userId]);
eq("group membership is replaceable", await enterprise.listGroupMemberIds(workspace.workspaceId, rolloutGroup.groupId), [viewerMembership.userId]);
eq("group reports its member count", (await enterprise.listGroups(workspace.workspaceId))[0].memberCount, 1);
await enterprise.upsertPermissionGrant({
  workspaceId: workspace.workspaceId,
  principalType: "group",
  principalId: rolloutGroup.groupId,
  permission: "chat.use",
  effect: "allow",
  conditions: { connectorProvider: "slack" },
});
ok(
  "conditional group grant enables matching connector",
  await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "chat.use", { connectorProvider: "slack" }),
);
ok(
  "conditional group grant does not enable another connector",
  !(await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "chat.use", { connectorProvider: "github" })),
);
const denyGrant = await enterprise.upsertPermissionGrant({
  workspaceId: workspace.workspaceId,
  principalType: "user",
  principalId: viewerMembership.userId,
  permission: "search.use",
  effect: "deny",
});
ok("user deny overrides viewer search role", !(await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "search.use")));
ok("permission grants remain workspace scoped", (await enterprise.listPermissionGrants(workspace.workspaceId)).length === 2);
ok("permission grant can be deleted", await enterprise.deletePermissionGrant(workspace.workspaceId, denyGrant.grantId));
ok("deleting deny restores viewer search", await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "search.use"));
const principals = await enterprise.userContentPrincipals(viewerMembership.userId, workspace.workspaceId);
ok("content principals include normalized email", principals.has("email:viewer@example.com"));
ok("content principals include internal group", principals.has(`group:${rolloutGroup.groupId}`));
ok("content principals include external group", principals.has("external_group:drive-group:ai-rollout@example.com"));
const audit = await enterprise.recordAuditEvent({
  workspaceId: workspace.workspaceId,
  actorUserId: ownerUser.userId,
  action: "membership.invited",
  targetType: "user",
  targetId: viewerMembership.userId,
  requestId: "req-1",
  details: { role: "viewer" },
});
ok("audit event is appendable", audit.action === "membership.invited");
eq("audit events remain workspace scoped", (await enterprise.listAuditEvents(workspace.workspaceId)).map((event) => event.eventId), [audit.eventId]);
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  status: "suspended",
});
ok("suspended member loses product access", !(await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "search.use")));
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  status: "active",
});
eq("user workspace list is membership based", (await enterprise.listUserWorkspaces(viewerMembership.userId)).map((item) => item.workspaceId), [workspace.workspaceId]);

// --- permission-aware content, connector policy, sync, search, and chat ---
const driveConnector = await db.upsertConnector({
  workspaceId: workspace.workspaceId,
  provider: "gdrive",
  externalId: "drive-content",
  displayName: "Acme Drive",
  capabilities: ["ingest", "query"],
});
const driveResource = await db.upsertConnectorResource({
  connectorId: driveConnector.connectorId,
  externalId: "shared-drive-1",
  kind: "shared_drive",
  displayName: "Engineering Drive",
});
const hiddenResource = await db.upsertConnectorResource({
  connectorId: driveConnector.connectorId,
  externalId: "shared-drive-hidden",
  kind: "shared_drive",
  displayName: "Disabled Drive",
  enabled: false,
});
await contentDb.storeConnectorCredentials({
  connectorId: driveConnector.connectorId,
  data: { refreshToken: "drive-refresh-secret", tokenType: "Bearer" },
  scopes: ["drive.readonly", "drive.metadata.readonly", "drive.readonly"],
  expiresAt: "2026-08-01T00:00:00Z",
});
const driveCredentials = await contentDb.getConnectorCredentials(driveConnector.connectorId);
ok("connector credentials decrypt correctly", driveCredentials?.data.refreshToken === "drive-refresh-secret");
eq("connector credential scopes are deduplicated", driveCredentials?.scopes, ["drive.readonly", "drive.metadata.readonly"]);
const rawCredential = await sql.query(`SELECT encrypted_data FROM connector_credentials WHERE connector_id = $1`, [driveConnector.connectorId]);
ok("connector refresh token is not stored as plaintext", !String(rawCredential.rows[0].encrypted_data).includes("drive-refresh-secret"));

const workspaceContent = await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  resourceId: driveResource.resourceId,
  externalId: "workspace-roadmap",
  sourceType: "document",
  title: "Platform roadmap",
  body: "The roadmap moves permission-aware search into production.",
  visibility: "workspace",
  aclStatus: "failed",
  sourceUpdatedAt: "2026-07-20T00:00:00Z",
});
const ownerContent = await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  resourceId: driveResource.resourceId,
  externalId: "owner-roadmap",
  sourceType: "document",
  title: "Owner compensation roadmap",
  body: "Private roadmap details for the owner only.",
  visibility: "restricted",
  aclStatus: "current",
  acls: [{ principalType: "email", principalKey: "owner@example.com" }],
});
const groupContent = await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  resourceId: driveResource.resourceId,
  externalId: "group-roadmap",
  sourceType: "document",
  title: "AI rollout roadmap",
  body: "The group roadmap covers the permission-aware assistant rollout.",
  visibility: "restricted",
  aclStatus: "current",
  acls: [{ principalType: "external_group", principalKey: "drive-group:ai-rollout@example.com" }],
});
await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  resourceId: driveResource.resourceId,
  externalId: "stale-roadmap",
  sourceType: "document",
  title: "Stale private roadmap",
  body: "This stale roadmap must fail closed.",
  visibility: "restricted",
  aclStatus: "stale",
  acls: [{ principalType: "email", principalKey: "viewer@example.com" }],
});
await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  resourceId: driveResource.resourceId,
  externalId: "empty-acl-roadmap",
  sourceType: "document",
  title: "Empty ACL roadmap",
  body: "This restricted item has no principals and must fail closed.",
  visibility: "restricted",
  aclStatus: "current",
  acls: [],
});
await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  resourceId: hiddenResource.resourceId,
  externalId: "hidden-resource-roadmap",
  sourceType: "document",
  title: "Disabled resource roadmap",
  body: "This content belongs to a disabled resource.",
  visibility: "workspace",
  aclStatus: "current",
});
const ownerSearch = await contentDb.authorizedSearch({
  workspaceId: workspace.workspaceId,
  userId: ownerUser.userId,
  query: "roadmap",
  provider: "gdrive",
});
ok("owner search sees workspace and direct ACL content", ownerSearch.some((item) => item.itemId === workspaceContent.itemId) && ownerSearch.some((item) => item.itemId === ownerContent.itemId));
ok("owner search does not bypass group ACL", !ownerSearch.some((item) => item.itemId === groupContent.itemId));
const viewerSearch = await contentDb.authorizedSearch({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  query: "roadmap",
});
ok("viewer search sees workspace and matching group ACL", viewerSearch.some((item) => item.itemId === workspaceContent.itemId) && viewerSearch.some((item) => item.itemId === groupContent.itemId));
ok("viewer search cannot see direct owner ACL", !viewerSearch.some((item) => item.itemId === ownerContent.itemId));
ok("stale, empty ACL, and disabled resources fail closed", viewerSearch.length === 2, JSON.stringify(viewerSearch));
eq("empty search query rejects", await contentDb.authorizedSearch({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, query: " " }).then(() => "accepted", error => error.message), "query is required");
eq("oversized content rejects", await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  externalId: "too-large",
  sourceType: "document",
  title: "Too large",
  body: "x".repeat(2_000_001),
}).then(() => "accepted", error => error.message), "content exceeds 2 MB limit");

const includePolicy = await contentDb.upsertConnectorPolicy({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  effect: "include",
  field: "resourceId",
  operator: "equals",
  values: ["shared-drive-1"],
});
const excludePolicy = await contentDb.upsertConnectorPolicy({
  workspaceId: workspace.workspaceId,
  connectorId: driveConnector.connectorId,
  effect: "exclude",
  field: "path",
  operator: "starts_with",
  values: ["/engineering/private"],
});
ok("connector policy includes an allowed drive", await contentDb.connectorContentAllowed(workspace.workspaceId, driveConnector.connectorId, {
  provider: "gdrive", resourceId: "shared-drive-1", owner: "", mimeType: "text/plain", path: "/engineering/public", sourceType: "document",
}));
ok("connector exclusion overrides inclusion", !(await contentDb.connectorContentAllowed(workspace.workspaceId, driveConnector.connectorId, {
  provider: "gdrive", resourceId: "shared-drive-1", owner: "", mimeType: "text/plain", path: "/engineering/private/payroll", sourceType: "document",
})));
ok("connector policies list by workspace", (await contentDb.listConnectorPolicies(workspace.workspaceId)).length === 2);
ok("connector policy can be deleted", await contentDb.deleteConnectorPolicy(workspace.workspaceId, excludePolicy.policyId));
ok("other connector policy remains", (await contentDb.listConnectorPolicies(workspace.workspaceId)).some((policy) => policy.policyId === includePolicy.policyId));

const syncRun = await contentDb.startConnectorSync(workspace.workspaceId, driveConnector.connectorId);
const finishedSync = await contentDb.finishConnectorSync({
  workspaceId: workspace.workspaceId,
  runId: syncRun.runId,
  status: "succeeded",
  cursorValue: "cursor-2",
  itemsSeen: 8,
  itemsWritten: 6,
  itemsDeleted: 1,
});
ok("connector sync records completion and counts", finishedSync?.status === "succeeded" && finishedSync.itemsWritten === 6);
ok("finished sync cannot be finished twice", await contentDb.finishConnectorSync({ workspaceId: workspace.workspaceId, runId: syncRun.runId, status: "failed" }) === null);
eq("latest sync is available per connector", (await contentDb.latestConnectorSyncs(workspace.workspaceId)).map((run) => run.runId), [syncRun.runId]);

const exchange = await contentDb.createChatExchange({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  question: "What is the rollout roadmap?",
  answer: "The rollout adds a permission-aware assistant [1].",
  citationItemIds: [groupContent.itemId],
});
ok("chat exchange creates a user-owned thread", (await contentDb.listChatThreads(workspace.workspaceId, viewerMembership.userId))[0].threadId === exchange.threadId);
ok("authorized chat citation renders", (await contentDb.listAuthorizedChatMessages(workspace.workspaceId, viewerMembership.userId, exchange.threadId))[1].citations.length === 1);
await enterprise.replaceGroupMembers(workspace.workspaceId, rolloutGroup.groupId, []);
const revokedChat = (await contentDb.listAuthorizedChatMessages(workspace.workspaceId, viewerMembership.userId, exchange.threadId))[1];
ok("historical chat citation disappears after ACL revocation", revokedChat.citations.length === 0);
eq("historical answer is redacted after ACL revocation", revokedChat.content, "This answer is unavailable because your source access changed.");
ok("another user cannot read the chat thread", (await contentDb.listAuthorizedChatMessages(workspace.workspaceId, ownerUser.userId, exchange.threadId)).length === 0);
ok("deleted content disappears from search", await contentDb.markContentDeleted(workspace.workspaceId, driveConnector.connectorId, "workspace-roadmap"));
ok("deleted content is no longer returned", !(await contentDb.authorizedSearch({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, query: "permission-aware" })).some((item) => item.itemId === workspaceContent.itemId));
const rateOne = await enterprise.consumeRateLimit({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, action: "search-test", limit: 2 });
const rateTwo = await enterprise.consumeRateLimit({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, action: "search-test", limit: 2 });
const rateThree = await enterprise.consumeRateLimit({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, action: "search-test", limit: 2 });
ok("rate limit permits requests through the boundary", rateOne.allowed && rateTwo.allowed);
ok("rate limit rejects overflow", !rateThree.allowed && rateThree.remaining === 0 && rateThree.retryAfterSeconds > 0);
const foreignWorkspace = await db.createWorkspace({
  displayName: "Foreign workspace",
  datasetName: "foreign-dataset",
  cogneeApiKey: "foreign-key",
});
await enterprise.bootstrapWorkspaceMembership(viewerMembership.userId, foreignWorkspace.workspaceId);
const foreignConnector = await db.upsertConnector({
  workspaceId: foreignWorkspace.workspaceId,
  provider: "gdrive",
  externalId: "foreign-drive",
  displayName: "Foreign Drive",
  capabilities: ["ingest", "query"],
});
const foreignContent = await contentDb.upsertContentItem({
  workspaceId: foreignWorkspace.workspaceId,
  connectorId: foreignConnector.connectorId,
  externalId: "foreign-roadmap",
  sourceType: "document",
  title: "Foreign roadmap",
  body: "This permission-aware roadmap belongs to another workspace.",
  visibility: "workspace",
  aclStatus: "current",
});
ok("content id from another workspace is rejected", (await contentDb.getAuthorizedItemsByIds({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  itemIds: [foreignContent.itemId],
})).length === 0);
await db.deleteWorkspace(foreignWorkspace.workspaceId);

// --- tenant_config defaults ---
const cfg = await db.getTenantConfig(INST);
ok("config defaults: llmProvider deepseek", cfg.llmProvider === "deepseek");
ok("config defaults: blockOnRepropose true", cfg.blockOnRepropose === true);
ok("config defaults: deliveryMode check", cfg.deliveryMode === "check");

// --- decision_records: repo-scoping + collision across repos ---
const mk = (repo, id, outcome = "rejected") => ({
  decisionId: id, installationId: INST, repo, sourceType: "pr", sourceUrl: `https://x/${id}`,
  title: `${id} title`, outcome, reasoningText: `reason for ${id}`, decidedAt: "2026-01-01T00:00:00Z",
  terms: ["redis", "cache"], cogneeDataId: `data-${repo}-${id}`, createdAt: "",
});
await db.upsertDecisionRecord(mk("acme/a", "PR-42"));
await db.upsertDecisionRecord(mk("acme/b", "PR-42")); // SAME id, different repo — must not collide
await db.initSchema();
const githubResources = await db.listConnectorResources(githubConnector.connectorId);
eq("schema migration backfills repository resources", githubResources.map((resource) => resource.externalId), ["acme/a", "acme/b"]);
const aRecs = await db.getDecisionRecords(INST, "acme/a");
const bRecs = await db.getDecisionRecords(INST, "acme/b");
eq("repo a sees only its PR-42", aRecs.map(r => `${r.repo}:${r.decisionId}`), ["acme/a:PR-42"]);
eq("repo b sees only its PR-42", bRecs.map(r => `${r.repo}:${r.decisionId}`), ["acme/b:PR-42"]);
const wide = await db.getDecisionRecords(INST); // installation-wide (adapters)
ok("installation-wide sees both repos' PR-42", wide.length === 2);
const one = await db.getDecisionRecord(INST, "acme/a", "PR-42");
ok("getDecisionRecord repo-scoped", one?.repo === "acme/a" && one?.sourceUrl === "https://x/PR-42");

// --- supersession: exact (setSuperseded) must not touch the other repo ---
await db.setSuperseded(INST, "acme/a", "PR-42", "OVERRIDE-1");
const aAfter = await db.getDecisionRecord(INST, "acme/a", "PR-42");
const bAfter = await db.getDecisionRecord(INST, "acme/b", "PR-42");
ok("setSuperseded marked repo a", aAfter?.supersededBy === "OVERRIDE-1");
ok("setSuperseded left repo b untouched (no cross-repo bleed)", bAfter?.supersededBy === undefined);

// markSuperseded matches EXACT GitHub-item ids (PR-<n>/ISSUE-<n>) only — never a wildcard suffix.
await db.upsertDecisionRecord(mk("acme/a", "PR-7"));
await db.upsertDecisionRecord(mk("acme/a", "DOC-7")); // must NOT be collaterally superseded by "#7"
await db.markSuperseded(INST, "acme/a", ["#7"], "OVERRIDE-2");
ok("markSuperseded matches exact PR-<n>", (await db.getDecisionRecord(INST, "acme/a", "PR-7"))?.supersededBy === "OVERRIDE-2");
ok("markSuperseded leaves DOC-<n> untouched (no wildcard collateral)", (await db.getDecisionRecord(INST, "acme/a", "DOC-7"))?.supersededBy === undefined);

// --- deliveries + idempotency + IDOR guard helpers ---
await db.upsertDelivery({ installationId: INST, repo: "acme/a", prNumber: 10, kind: "pr", headSha: "sha1", mode: "check", checkRunId: 555, decisionId: "PR-42", sessionId: "sess-pr-10", state: "posted" });
const del = await db.getDelivery(INST, "acme/a", 10, "sha1");
ok("delivery roundtrip", del?.checkRunId === 555 && del?.sessionId === "sess-pr-10");
eq("getPrSession returns stored session", await db.getPrSession(INST, "acme/a", 10), "sess-pr-10");
eq("getLatestDecisionForPr", await db.getLatestDecisionForPr(INST, "acme/a", 10), "PR-42");
ok("decisionFlaggedOnThread true for flagged", await db.decisionFlaggedOnThread(INST, "acme/a", 10, "PR-42") === true);
ok("decisionFlaggedOnThread false cross-repo", await db.decisionFlaggedOnThread(INST, "acme/b", 10, "PR-42") === false);
await db.upsertDelivery({ installationId: INST, repo: "acme/a", prNumber: 11, kind: "issue", headSha: "", mode: "comment", state: "failed", errorText: "fetch failed" });
const failedDelivery = await db.getDelivery(INST, "acme/a", 11, "");
ok("failed catch stores a dashboard-safe error", failedDelivery?.state === "failed" && failedDelivery?.errorText === "fetch failed");
await db.upsertDelivery({ installationId: INST, repo: "acme/a", prNumber: 11, kind: "issue", headSha: "", mode: "comment", state: "clear" });
const recoveredDelivery = await db.getDelivery(INST, "acme/a", 11, "");
ok("successful retry clears the old error", recoveredDelivery?.state === "clear" && recoveredDelivery?.errorText === null);
await db.ignoreDeliveries(INST, "acme/a", 10);
const delIgnored = await db.getDelivery(INST, "acme/a", 10, "sha1");
ok("ignoreDeliveries flips state", delIgnored?.state === "ignored");

// --- preflight keys (hash lookup + revoke) ---
await db.insertPreflightKey("hash-abc", INST, "acme/a");
eq("lookupPreflightKey resolves", await db.lookupPreflightKey("hash-abc"), { installationId: INST, repo: "acme/a" });
ok("lookupPreflightKey unknown → null", await db.lookupPreflightKey("nope") === null);

// --- feedback_pending: record + race-safe drain grouping ---
await db.recordFeedbackPending(INST, "sess-A");
await db.recordFeedbackPending(INST, "sess-B");
await db.recordFeedbackPending(INST, "sess-A"); // dup → ON CONFLICT DO NOTHING
await db.upsertInstallation({ installationId: 900002, githubAccount: "beta", datasetName: "repo-900002", cogneeApiKey: "k2" });
await db.recordFeedbackPending(900002, "sess-C");
const drained = await db.drainFeedbackPending();
ok("drain groups by installation", drained.get(INST)?.sort().join(",") === "sess-A,sess-B" && drained.get(900002)?.join(",") === "sess-C");
const drainedAgain = await db.drainFeedbackPending();
ok("drain is exhaustive (second drain empty)", drainedAgain.size === 0);

// --- tenant_links (Slack/Linear → installation) ---
await db.linkTenant("slack", "T123", INST);
eq("resolveLink", await db.resolveLink("slack", "T123"), INST);
ok("resolveLink unknown → null", await db.resolveLink("slack", "T999") === null);
const linkedSlackConnector = await db.getConnector("slack", "T123");
ok("tenant link creates a Slack connector", linkedSlackConnector?.workspaceId === workspace.workspaceId);
await sql.query(`DELETE FROM connectors WHERE provider = 'slack' AND external_id = 'T123'`);
await db.initSchema();
ok("schema migration backfills tenant link connectors", (await db.getConnector("slack", "T123"))?.workspaceId === workspace.workspaceId);
await db.linkTenant("linear", "L-unlink", INST);
await db.unlinkTenant("linear", "L-unlink");
ok("unlink removes the compatibility link", (await db.resolveLink("linear", "L-unlink")) === null);
ok("unlink removes the connector", (await db.getConnector("linear", "L-unlink")) === null);

const independentWorkspace = await db.createWorkspace({
  displayName: "Standalone Slack",
  datasetName: "workspace-standalone",
  cogneeApiKey: "standalone-key",
});
ok("independent workspace has no GitHub installation", (await db.getWorkspaceByInstallation(999999999)) === null);
const independentConnector = await db.upsertConnector({
  workspaceId: independentWorkspace.workspaceId,
  provider: "slack",
  externalId: "T-independent",
  displayName: "Standalone Slack",
  capabilities: ["query", "record"],
});
eq("independent connector stores capabilities", independentConnector.capabilities, ["query", "record"]);
const independentResource = await db.upsertConnectorResource({
  connectorId: independentConnector.connectorId,
  externalId: " C-engineering ",
  kind: " Channel ",
  displayName: "Engineering",
});
ok("connector resource normalizes its identity", independentResource.externalId === "C-engineering" && independentResource.kind === "channel");
const disabledResource = await db.upsertConnectorResource({
  connectorId: independentConnector.connectorId,
  externalId: "C-engineering",
  kind: "channel",
  displayName: "Engineering Team",
  enabled: false,
});
ok("connector resource update is idempotent", disabledResource.resourceId === independentResource.resourceId && disabledResource.enabled === false);
eq("connector resources remain scoped", (await db.listConnectorResources(independentConnector.connectorId)).map((resource) => resource.displayName), ["Engineering Team"]);
ok("disabled resource blocks connector activity", await db.connectorAllowsResource("slack", "T-independent", "channel", "C-engineering") === false);
ok("missing connector blocks activity", await db.connectorAllowsResource("slack", "T-missing", "channel", "C-engineering") === false);
ok("empty resource identity blocks activity", await db.connectorAllowsResource("slack", "T-independent", "channel", "") === false);
const disabledConnector = await db.setConnectorEnabled(independentWorkspace.workspaceId, independentConnector.connectorId, false);
ok("connector can be disabled within its workspace", disabledConnector?.status === "disabled");
ok("disabled connector blocks unregistered resources", await db.connectorAllowsResource("slack", "T-independent", "channel", "C-other") === false);
ok("connector cannot be changed from another workspace", await db.setConnectorEnabled(workspace.workspaceId, independentConnector.connectorId, true) === null);
const enabledConnector = await db.setConnectorEnabled(independentWorkspace.workspaceId, independentConnector.connectorId, true);
ok("connector can be enabled again", enabledConnector?.status === "active");
const enabledResource = await db.setConnectorResourceEnabled(independentWorkspace.workspaceId, independentResource.resourceId, true);
ok("connector resource can be enabled within its workspace", enabledResource?.enabled === true);
ok("enabled resource allows connector activity", await db.connectorAllowsResource("slack", "T-independent", "channel", "C-engineering") === true);
ok("unregistered resource inherits active connector status", await db.connectorAllowsResource("slack", "T-independent", "channel", "C-other") === true);
ok("connector resource cannot be changed from another workspace", await db.setConnectorResourceEnabled(workspace.workspaceId, independentResource.resourceId, false) === null);
await db.deleteWorkspace(independentWorkspace.workspaceId);
ok("workspace deletion cascades connectors", (await db.getConnector("slack", "T-independent")) === null);

// --- slack_installs: ENCRYPTED roundtrip ---
const install = { team: { id: "T123" }, bot: { token: "xoxb-super-secret" } };
await db.storeSlackInstall("T123", install);
const fetched = await db.fetchSlackInstall("T123");
eq("slack install decrypts to original", fetched, install);
// (plaintext-at-rest is verified separately via psql in the runner)

// --- metrics ---
await db.upsertDelivery({ installationId: INST, repo: "acme/a", prNumber: 20, kind: "pr", headSha: "s", decisionId: "PR-42", state: "posted" });
const m = await db.metrics(INST, "acme/a");
// PR 10 was ignored above → only PR 20 is a live 'posted' flag. Ignored deliveries must NOT count.
ok("metrics.prsPrevented counts only non-ignored flagged PRs", m.prsPrevented === 1, JSON.stringify(m));
ok("metrics.decisionsTracked", m.decisionsTracked === 3, JSON.stringify(m)); // PR-42 + PR-7 + DOC-7 in acme/a
ok("metrics.rejectionsActive excludes superseded", m.rejectionsActive === 1, JSON.stringify(m)); // only DOC-7 active

// --- deleteInstallation: cascade + explicit cleanup ---
await db.deleteInstallation(INST);
ok("installation gone", await db.getInstallation(INST) === null);
ok("workspace compatibility row is removed", (await db.getWorkspaceByInstallation(INST)) === null);
ok("workspace connector rows are removed", (await db.getConnector("github", String(INST))) === null);
ok("decision_records cascaded", (await db.getDecisionRecords(INST, "acme/a")).length === 0);
ok("deliveries cleared", await db.getDelivery(INST, "acme/a", 10, "sha1") === null);
ok("preflight_keys cascaded", await db.lookupPreflightKey("hash-abc") === null);
ok("tenant_links cascaded", await db.resolveLink("slack", "T123") === null);

await sql.end();
console.log(`\n=== db integration: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
