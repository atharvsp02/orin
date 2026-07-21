// End-to-end DB-layer integration test against a REAL Postgres. Exercises every function the
// session added/changed. Run with DATABASE_URL pointed at the local cluster.
process.env.ORIN_SECRET ??= "integration-secret-please-rotate-000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const BOT = new URL("../../dist/", import.meta.url).href;
const db = await import(`${BOT}db.js`);
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
