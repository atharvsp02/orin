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
const slack = await import(`${BOT}slack.js`);
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
eq(
  "an external identity cannot be transferred between users",
  await enterprise.addUserIdentity(adminUser.userId, {
    provider: "github_login",
    externalId: "owner",
    handle: "owner",
  }).then(() => "transferred", error => error.message),
  "identity is already linked to another user",
);
ok("rejected identity transfer preserves its owner", (await enterprise.getUserByIdentity("github_login", "owner"))?.userId === ownerUser.userId);
const viewerMembership = await enterprise.inviteWorkspaceMember({
  workspaceId: workspace.workspaceId,
  email: "viewer@example.com",
  displayName: "Workspace Viewer",
  role: "viewer",
});
ok("email invitation creates viewer membership", viewerMembership.role === "viewer");
eq(
  "a non-owner cannot demote an owner through an invitation",
  await enterprise.inviteWorkspaceMember({
    workspaceId: workspace.workspaceId,
    email: "owner@example.com",
    displayName: "Changed without permission",
    role: "viewer",
  }).then(() => "changed", error => error.message),
  "only an owner can change owner access",
);
eq("a rejected invitation cannot mutate owner profile data", (await enterprise.getUser(ownerUser.userId))?.displayName, "Workspace Owner");
eq(
  "a rejected owner invitation does not create a user",
  await enterprise.inviteWorkspaceMember({
    workspaceId: workspace.workspaceId,
    email: "rejected-owner@example.com",
    role: "owner",
  }).then(() => "created", error => error.message),
  "only an owner can change owner access",
);
ok("rejected owner identity is absent", (await enterprise.getUserByIdentity("email", "rejected-owner@example.com")) === null);
const inactiveDirectoryUser = await enterprise.upsertUserIdentity({
  provider: "slack_user",
  externalId: "T-directory:U-inactive",
  displayName: "Inactive directory user",
  email: "inactive-directory@example.com",
});
await sql.query(`UPDATE users SET status = 'inactive' WHERE user_id = $1`, [inactiveDirectoryUser.userId]);
await enterprise.upsertUserIdentity({
  provider: "slack_user",
  externalId: "T-directory:U-inactive",
  displayName: "Inactive directory user",
  email: "inactive-directory@example.com",
  reactivate: false,
});
eq("directory synchronization cannot reactivate a disabled user", (await enterprise.getUser(inactiveDirectoryUser.userId))?.status, "inactive");
eq("active owner count", await enterprise.countActiveOwners(workspace.workspaceId), 1);
eq(
  "the last active owner cannot be suspended",
  await enterprise.updateWorkspaceMember({
    workspaceId: workspace.workspaceId,
    userId: ownerUser.userId,
    status: "suspended",
    allowOwnerChange: true,
  }).then(() => "suspended", error => error.message),
  "a workspace must keep at least one active owner",
);
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: adminUser.userId,
  role: "owner",
  allowOwnerChange: true,
});
const concurrentOwnerChanges = await Promise.allSettled([
  enterprise.updateWorkspaceMember({
    workspaceId: workspace.workspaceId,
    userId: ownerUser.userId,
    role: "admin",
    allowOwnerChange: true,
  }),
  enterprise.updateWorkspaceMember({
    workspaceId: workspace.workspaceId,
    userId: adminUser.userId,
    role: "admin",
    allowOwnerChange: true,
  }),
]);
ok("concurrent owner changes keep one active owner", concurrentOwnerChanges.filter((result) => result.status === "fulfilled").length === 1);
eq("owner invariant survives concurrent updates", await enterprise.countActiveOwners(workspace.workspaceId), 1);
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: ownerUser.userId,
  role: "owner",
  allowOwnerChange: true,
});
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: adminUser.userId,
  role: "admin",
  allowOwnerChange: true,
});
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: adminUser.userId,
  status: "suspended",
});
const suspendedBootstrap = await enterprise.bootstrapWorkspaceMembership(adminUser.userId, workspace.workspaceId);
ok("GitHub bootstrap cannot reactivate a suspended membership", suspendedBootstrap.status === "suspended");
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: adminUser.userId,
  status: "active",
});
ok("viewer receives default search access", await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "search.use"));
ok("viewer has no default chat access", !(await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "chat.use")));

const rolloutGroup = await enterprise.createGroup({
  workspaceId: workspace.workspaceId,
  displayName: "AI rollout",
  externalId: "AI-ROLLOUT@EXAMPLE.COM",
});
eq("external group identities are normalized", rolloutGroup.externalId, "ai-rollout@example.com");
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
ok("permission grant can be read within its workspace", (await enterprise.getPermissionGrant(workspace.workspaceId, denyGrant.grantId))?.grantId === denyGrant.grantId);
eq(
  "permission grant rejects a missing workspace user",
  await enterprise.upsertPermissionGrant({
    workspaceId: workspace.workspaceId,
    principalType: "user",
    principalId: "123e4567-e89b-12d3-a456-426614174099",
    permission: "search.use",
    effect: "allow",
  }).then(() => "created", error => error.message),
  "grant user is not a workspace member",
);
ok("permission grants remain workspace scoped", (await enterprise.listPermissionGrants(workspace.workspaceId)).length === 2);
ok("permission grant can be deleted", await enterprise.deletePermissionGrant(workspace.workspaceId, denyGrant.grantId));
ok("deleting deny restores viewer search", await enterprise.userCan(viewerMembership.userId, workspace.workspaceId, "search.use"));
const principals = await enterprise.userContentPrincipals(viewerMembership.userId, workspace.workspaceId);
ok("content principals include normalized email", principals.has("email:viewer@example.com"));
ok("content principals include internal group", principals.has(`group:${rolloutGroup.groupId}`));
ok("content principals include external group", principals.has("external_group:ai-rollout@example.com"));
const disposableGroup = await enterprise.createGroup({
  workspaceId: workspace.workspaceId,
  displayName: "Disposable group",
});
const disposableGrant = await enterprise.upsertPermissionGrant({
  workspaceId: workspace.workspaceId,
  principalType: "group",
  principalId: disposableGroup.groupId,
  permission: "chat.use",
  effect: "allow",
});
ok("group deletion succeeds", await enterprise.deleteGroup(workspace.workspaceId, disposableGroup.groupId));
ok("group deletion removes dangling grants", (await enterprise.getPermissionGrant(workspace.workspaceId, disposableGrant.grantId)) === null);
const concurrentGroup = await enterprise.createGroup({
  workspaceId: workspace.workspaceId,
  displayName: "Concurrent group",
});
const [, concurrentDelete] = await Promise.allSettled([
  enterprise.upsertPermissionGrant({
    workspaceId: workspace.workspaceId,
    principalType: "group",
    principalId: concurrentGroup.groupId,
    permission: "chat.use",
    effect: "allow",
  }),
  enterprise.deleteGroup(workspace.workspaceId, concurrentGroup.groupId),
]);
ok("concurrent group deletion completes", concurrentDelete.status === "fulfilled" && concurrentDelete.value === true);
ok(
  "concurrent group deletion cannot leave a dangling grant",
  !(await enterprise.listPermissionGrants(workspace.workspaceId)).some((grant) => grant.principalId === concurrentGroup.groupId),
);
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
ok("connector can be resolved by workspace and id", (await db.getConnectorById(workspace.workspaceId, driveConnector.connectorId))?.externalId === "drive-content");
ok("active provider connector listing is provider scoped", (await db.listActiveConnectorsByProvider("gdrive")).some((connector) => connector.connectorId === driveConnector.connectorId));
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
  acls: [{ principalType: "external_group", principalKey: "ai-rollout@example.com" }],
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
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  status: "suspended",
});
ok("search SQL rejects a suspended member", (await contentDb.authorizedSearch({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  permission: "search.use",
  query: "roadmap",
})).length === 0);
await enterprise.updateWorkspaceMember({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  status: "active",
});
ok("search treats SQL wildcard characters literally", (await contentDb.authorizedSearch({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  query: "%",
})).length === 0);
const providerDeny = await enterprise.upsertPermissionGrant({
  workspaceId: workspace.workspaceId,
  principalType: "user",
  principalId: viewerMembership.userId,
  permission: "search.use",
  effect: "deny",
  conditions: { connectorProvider: "gdrive" },
});
ok("conditional feature deny filters matching search items in SQL", (await contentDb.authorizedSearch({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  permission: "search.use",
  query: "roadmap",
})).length === 0);
await enterprise.deletePermissionGrant(workspace.workspaceId, providerDeny.grantId);
const driveChatGrant = await enterprise.upsertPermissionGrant({
  workspaceId: workspace.workspaceId,
  principalType: "group",
  principalId: rolloutGroup.groupId,
  permission: "chat.use",
  effect: "allow",
  conditions: { connectorProvider: "gdrive", sourceType: "document" },
});
const driveChatEvidence = await contentDb.authorizedSearch({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  permission: "chat.use",
  query: "roadmap",
});
ok("conditional feature allow admits only matching chat evidence", driveChatEvidence.length === 2 && driveChatEvidence.every((item) => item.provider === "gdrive" && item.sourceType === "document"));
await db.setConnectorStatus(workspace.workspaceId, driveConnector.connectorId, "error");
ok("connector error hides all of its search content", (await contentDb.authorizedSearch({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  query: "roadmap",
})).length === 0);
await db.setConnectorStatus(workspace.workspaceId, driveConnector.connectorId, "active");
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

const reconciliationConnector = await db.upsertConnector({
  workspaceId: workspace.workspaceId,
  provider: "gdrive",
  externalId: "drive-reconciliation",
  displayName: "Drive reconciliation fixture",
  capabilities: ["ingest", "query"],
});
const staleContent = await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: reconciliationConnector.connectorId,
  externalId: "stale-after-full-sync",
  sourceType: "document",
  title: "Stale full sync item",
  body: "This item is absent from the next full source listing.",
  visibility: "workspace",
});
const temporarilyFailedContent = await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: reconciliationConnector.connectorId,
  externalId: "failed-during-full-sync",
  sourceType: "document",
  title: "Temporarily unavailable item",
  body: "This item must fail closed without being treated as deleted.",
  visibility: "restricted",
  aclStatus: "current",
  acls: [{ principalType: "email", principalKey: "owner@example.com" }],
});
const syncRun = await contentDb.startConnectorSync(workspace.workspaceId, reconciliationConnector.connectorId);
eq(
  "a connector cannot start overlapping sync runs",
  await contentDb.startConnectorSync(workspace.workspaceId, reconciliationConnector.connectorId)
    .then(() => "started", error => error.message),
  "connector sync is already running or connector was not found",
);
const refreshedContent = await contentDb.upsertContentItem({
  workspaceId: workspace.workspaceId,
  connectorId: reconciliationConnector.connectorId,
  externalId: "seen-during-full-sync",
  sourceType: "document",
  title: "Current full sync item",
  body: "This item was seen during the full source listing.",
  visibility: "workspace",
  syncRunId: syncRun.runId,
});
ok("a transient item failure is recorded without deleting content", await contentDb.markContentSyncFailed(
  workspace.workspaceId,
  reconciliationConnector.connectorId,
  "failed-during-full-sync",
  syncRun.runId,
));
const reconciled = await contentDb.markConnectorContentNotSeenInRun(workspace.workspaceId, reconciliationConnector.connectorId, syncRun.runId);
ok("full sync reconciliation deletes only content not seen during the run", reconciled >= 1);
ok("full sync reconciliation hides the stale item", (await contentDb.getAuthorizedItemsByIds({
  workspaceId: workspace.workspaceId,
  userId: ownerUser.userId,
  itemIds: [staleContent.itemId],
})).length === 0);
ok("full sync reconciliation keeps refreshed content", (await contentDb.getAuthorizedItemsByIds({
  workspaceId: workspace.workspaceId,
  userId: ownerUser.userId,
  itemIds: [refreshedContent.itemId],
})).length === 1);
ok("transiently failed content fails closed", (await contentDb.getAuthorizedItemsByIds({
  workspaceId: workspace.workspaceId,
  userId: ownerUser.userId,
  itemIds: [temporarilyFailedContent.itemId],
})).length === 0);
const failedContentState = await sql.query(
  `SELECT acl_status, deleted_at FROM content_items WHERE item_id = $1`,
  [temporarilyFailedContent.itemId],
);
ok("transiently failed content remains recoverable", failedContentState.rows[0].acl_status === "failed" && failedContentState.rows[0].deleted_at === null);
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
const abandonedSync = await contentDb.startConnectorSync(workspace.workspaceId, reconciliationConnector.connectorId);
await sql.query(
  `UPDATE connector_sync_runs SET started_at = now() - interval '2 hours', heartbeat_at = now() - interval '2 hours' WHERE run_id = $1`,
  [abandonedSync.runId],
);
ok("an active sync can renew its lease", await contentDb.heartbeatConnectorSync(workspace.workspaceId, abandonedSync.runId));
ok("a renewed sync is not failed as stale", await contentDb.failStaleConnectorSyncs() === 0);
await sql.query(
  `UPDATE connector_sync_runs SET heartbeat_at = now() - interval '2 hours' WHERE run_id = $1`,
  [abandonedSync.runId],
);
ok("stale running syncs are failed for recovery", await contentDb.failStaleConnectorSyncs() === 1);
ok("a connector can sync again after stale-run recovery", Boolean(await contentDb.startConnectorSync(
  workspace.workspaceId,
  reconciliationConnector.connectorId,
).then(async (run) => {
  await contentDb.finishConnectorSync({ workspaceId: workspace.workspaceId, runId: run.runId, status: "succeeded" });
  return run;
})));

const exchange = await contentDb.createChatExchange({
  workspaceId: workspace.workspaceId,
  userId: viewerMembership.userId,
  question: "What is the rollout roadmap?",
  answer: "The rollout adds a permission-aware assistant [1].",
  citationItemIds: [groupContent.itemId],
});
ok("chat exchange creates a user-owned thread", (await contentDb.listChatThreads(workspace.workspaceId, viewerMembership.userId))[0].threadId === exchange.threadId);
const authorizedChat = await contentDb.listAuthorizedChatMessages(workspace.workspaceId, viewerMembership.userId, exchange.threadId, "chat.use");
ok("chat messages keep user and assistant order", authorizedChat[0]?.role === "user" && authorizedChat[1]?.role === "assistant");
ok("authorized chat citation renders", authorizedChat.find((message) => message.role === "assistant")?.citations.length === 1);
await enterprise.replaceGroupMembers(workspace.workspaceId, rolloutGroup.groupId, []);
const revokedChat = (await contentDb.listAuthorizedChatMessages(workspace.workspaceId, viewerMembership.userId, exchange.threadId, "chat.use")).find((message) => message.role === "assistant");
ok("historical chat citation disappears after ACL revocation", revokedChat?.citations.length === 0);
eq("historical answer is redacted after ACL revocation", revokedChat?.content, "This answer is unavailable because your source access changed.");
ok("another user cannot read the chat thread", (await contentDb.listAuthorizedChatMessages(workspace.workspaceId, ownerUser.userId, exchange.threadId)).length === 0);
await enterprise.deletePermissionGrant(workspace.workspaceId, driveChatGrant.grantId);
ok("deleted content disappears from search", await contentDb.markContentDeleted(workspace.workspaceId, driveConnector.connectorId, "workspace-roadmap"));
ok("deleted content is no longer returned", !(await contentDb.authorizedSearch({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, query: "permission-aware" })).some((item) => item.itemId === workspaceContent.itemId));
const rateOne = await enterprise.consumeRateLimit({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, action: "search-test", limit: 2 });
const rateTwo = await enterprise.consumeRateLimit({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, action: "search-test", limit: 2 });
const rateThree = await enterprise.consumeRateLimit({ workspaceId: workspace.workspaceId, userId: ownerUser.userId, action: "search-test", limit: 2 });
ok("rate limit permits requests through the boundary", rateOne.allowed && rateTwo.allowed);
ok("rate limit rejects overflow", !rateThree.allowed && rateThree.remaining === 0 && rateThree.retryAfterSeconds > 0);
await sql.query(
  `UPDATE request_rate_limits SET expires_at = now() - interval '1 second'
   WHERE workspace_id = $1 AND user_id = $2 AND action = 'search-test'`,
  [workspace.workspaceId, ownerUser.userId],
);
ok("expired rate limit buckets are pruned", await enterprise.pruneExpiredRateLimits() >= 1);
ok("a pruned rate limit bucket starts clean", (await enterprise.consumeRateLimit({
  workspaceId: workspace.workspaceId,
  userId: ownerUser.userId,
  action: "search-test",
  limit: 2,
})).remaining === 1);
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
eq(
  "chat citations reject content from another workspace",
  await contentDb.createChatExchange({
    workspaceId: workspace.workspaceId,
    userId: viewerMembership.userId,
    question: "Can I cite foreign content?",
    answer: "No.",
    citationItemIds: [foreignContent.itemId],
  }).then(() => "created", error => error.message),
  "chat citations do not belong to workspace",
);
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
  capabilities: ["ingest", "query", "record"],
});
eq("independent connector stores capabilities", independentConnector.capabilities, ["ingest", "query", "record"]);
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
const rediscoveredResource = await db.upsertConnectorResource({
  connectorId: independentConnector.connectorId,
  externalId: "C-engineering",
  kind: "channel",
  displayName: "Engineering Team",
});
ok("resource discovery preserves an administrator disable", rediscoveredResource.enabled === false);
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
await enterprise.bootstrapWorkspaceMembership(ownerUser.userId, independentWorkspace.workspaceId);
const slackOutsider = await enterprise.inviteWorkspaceMember({
  workspaceId: independentWorkspace.workspaceId,
  email: "slack-outsider@example.com",
  role: "viewer",
});
const slackClient = {
  conversations: {
    info: async () => ({ channel: { id: "C-secure", name: "secure-decisions", is_private: true, is_member: true } }),
    members: async () => ({ members: ["U-owner"], response_metadata: { next_cursor: "" } }),
  },
  users: {
    list: async () => ({
      members: [{ id: "U-owner", profile: { email: "owner@example.com" } }],
      response_metadata: { next_cursor: "" },
    }),
  },
};
eq("Slack message event writes permission-aware content", await slack.ingestSlackMessageEvent("T-independent", {
  type: "message",
  channel: "C-secure",
  ts: "1720000000.000100",
  user: "U-owner",
  text: "The secure Slack deployment decision uses blue green releases.",
}, slackClient), "written");
ok("Slack channel member can search an indexed message", (await contentDb.authorizedSearch({
  workspaceId: independentWorkspace.workspaceId,
  userId: ownerUser.userId,
  query: "blue green",
  provider: "slack",
})).length === 1);
const secureSlackResource = await db.getConnectorResource(independentConnector.connectorId, "channel", "C-secure");
await contentDb.replaceConnectorResourceMemberships(independentWorkspace.workspaceId, secureSlackResource.resourceId, []);
ok("Slack membership revocation immediately removes search access", (await contentDb.authorizedSearch({
  workspaceId: independentWorkspace.workspaceId,
  userId: ownerUser.userId,
  query: "blue green",
  provider: "slack",
})).length === 0);
await contentDb.replaceConnectorResourceMemberships(independentWorkspace.workspaceId, secureSlackResource.resourceId, [
  { principalType: "slack_user", principalKey: "T-independent:U-owner" },
]);
await contentDb.markConnectorResourceAclStatus(independentWorkspace.workspaceId, secureSlackResource.resourceId, "failed");
ok("failed Slack channel ACL synchronization fails closed", (await contentDb.authorizedSearch({
  workspaceId: independentWorkspace.workspaceId,
  userId: ownerUser.userId,
  query: "blue green",
  provider: "slack",
})).length === 0);
await contentDb.replaceConnectorResourceMemberships(independentWorkspace.workspaceId, secureSlackResource.resourceId, [
  { principalType: "slack_user", principalKey: "T-independent:U-owner" },
]);
await sql.query(
  `UPDATE connector_resources SET acl_synced_at = now() - interval '31 minutes' WHERE resource_id = $1`,
  [secureSlackResource.resourceId],
);
ok("expired Slack channel ACL synchronization fails closed", (await contentDb.authorizedSearch({
  workspaceId: independentWorkspace.workspaceId,
  userId: ownerUser.userId,
  query: "blue green",
  provider: "slack",
})).length === 0);
await contentDb.replaceConnectorResourceMemberships(independentWorkspace.workspaceId, secureSlackResource.resourceId, [
  { principalType: "slack_user", principalKey: "T-independent:U-owner" },
]);
ok("Slack channel non-member cannot search an indexed message", (await contentDb.authorizedSearch({
  workspaceId: independentWorkspace.workspaceId,
  userId: slackOutsider.userId,
  query: "blue green",
  provider: "slack",
})).length === 0);
eq("Slack deletion event removes indexed content", await slack.ingestSlackMessageEvent("T-independent", {
  type: "message",
  subtype: "message_deleted",
  channel: "C-secure",
  deleted_ts: "1720000000.000100",
}, slackClient), "deleted");
ok("deleted Slack message is no longer searchable", (await contentDb.authorizedSearch({
  workspaceId: independentWorkspace.workspaceId,
  userId: ownerUser.userId,
  query: "blue green",
  provider: "slack",
})).length === 0);
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
