// Integration test: drives the REAL cognee.ts REST client + the feedback lifecycle against a MOCK
// Cognee server (records requests to assert casing/multipart fields) + REAL Postgres. No LLM needed.
import http from "node:http";

const PORT = 8899;
process.env.DATABASE_URL ??= "postgres://cg@127.0.0.1:5433/orin";
process.env.COGNEE_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.ORIN_SECRET ??= "integration-secret-please-rotate-000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const seen = []; // {path, method, headers, raw}
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ path: req.url, method: req.method, headers: req.headers, raw });
    const j = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const p = req.url;
    if (p === "/api/v1/auth/register") return j({});
    if (p === "/api/v1/auth/login") return j({ access_token: "tok" });
    if (p.startsWith("/api/v1/permissions/tenants")) return j({ tenant_id: "ten-1" });
    if (p === "/api/v1/auth/api-keys") return j({ key: "apikey-1" });
    if (p === "/api/v1/remember") return j({ items: [{ id: "data-1" }] });
    if (p === "/api/v1/ontologies") return j({ key: "orin-decisions" });
    if (p === "/api/v1/search") {
      const b = JSON.parse(raw);
      if (b.searchType === "CHUNKS") return j([{ objects_result: [{ score: 0.2, payload: { document_name: "PR-42", document_id: "data-1", text: "redis rejected" } }] }]);
      if (b.searchType === "CODING_RULES") return j([{ search_result: ["Do not add new deps", "Use pg not mysql"] }]);
      return j([{ search_result: ["Because redis added ops burden."] }]);
    }
    if (p === "/api/v1/recall") return j([{ text: "Cited: PR-42 rejected redis." }]);
    if (p.startsWith("/api/v1/sessions/")) return j({ qas: [{ qa_id: "qa-1", question: "Does this pull request re-propose a past decision?\nadd redis" }] });
    if (p === "/api/v1/remember/entry") return j({ ok: true });
    if (p === "/api/v1/improve") return j({ ok: true });
    if (p === "/api/v1/datasets") return j([{ id: "ds-uuid", name: "repo-900100" }]);
    if (p.startsWith("/api/v1/visualize")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>graph</html>"); }
    if (p === "/api/v1/forget") return j({ ok: true });
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(PORT, r));

const BOT = new URL("../../dist/", import.meta.url).href;
const cognee = await import(`${BOT}cognee.js`);
const pipeline = await import(`${BOT}pipeline.js`);
const lifecycle = await import(`${BOT}lifecycle.js`);
const prim = await import(`${BOT}primitives.js`);
const tenantMod = await import(`${BOT}tenant.js`);
const db = await import(`${BOT}db.js`);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) pass++; else fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n}${c ? "" : `  ${e}`}`); };
const lastTo = (path) => [...seen].reverse().find((s) => s.path === path || s.path.startsWith(path));
const cog = { baseUrl: process.env.COGNEE_BASE_URL };
const creds = { apiKey: "apikey-1", tenantId: "ten-1" };
const DS = "repo-900100";

// --- provisionTenant (register→login→tenant→key) ---
const provisioned = await cognee.provisionTenant(cog, { email: "b@x.io", password: "pw", tenantName: "t" });
ok("provisionTenant returns apiKey+tenantId", provisioned.apiKey === "apikey-1" && provisioned.tenantId === "ten-1");

// --- remember: multipart field names + ontology_key + node_set (snake) ---
await cognee.remember(cog, creds, { datasetName: DS, filename: "PR-42.txt", content: "redis rejected", nodeSet: "coding_agent_rules", ontologyKey: "orin-decisions" });
const rem = lastTo("/api/v1/remember");
ok("remember sends X-Api-Key header", rem.headers["x-api-key"] === "apikey-1");
ok("remember multipart has datasetName", rem.raw.includes('name="datasetName"'));
ok("remember multipart has node_set (snake)", rem.raw.includes('name="node_set"'));
ok("remember multipart has ontology_key (snake)", rem.raw.includes('name="ontology_key"'));
ok("remember multipart has run_in_background", rem.raw.includes('name="run_in_background"'));

// --- uploadOntology: multipart ontology_key + ontology_file(.owl) ---
await cognee.uploadOntology(cog, creds, { ontologyKey: "orin-decisions", filename: "decision.owl", content: "<rdf/>" });
const ont = lastTo("/api/v1/ontologies");
ok("uploadOntology has ontology_key field", ont.raw.includes('name="ontology_key"'));
ok("uploadOntology has ontology_file .owl", ont.raw.includes('name="ontology_file"') && ont.raw.includes("decision.owl"));

// --- search: camelCase body ---
await cognee.search(cog, creds, { datasetName: DS, query: "q", searchType: "GRAPH_COMPLETION", includeReferences: true, topK: 5 });
const srch = JSON.parse(lastTo("/api/v1/search").raw);
ok("search body camelCase searchType/includeReferences", srch.searchType === "GRAPH_COMPLETION" && srch.includeReferences === true && srch.topK === 5);
ok("search datasets is array", Array.isArray(srch.datasets) && srch.datasets[0] === DS);

// --- searchChunksScored parse ---
const chunks = await cognee.searchChunksScored(cog, creds, { datasetName: DS, query: "add redis", topK: 5 });
ok("chunks parsed score/name/id/text", chunks[0]?.score === 0.2 && chunks[0]?.documentName === "PR-42" && chunks[0]?.documentId === "data-1");
const chunkReq = JSON.parse(lastTo("/api/v1/search").raw);
ok("chunks request sets verbose+CHUNKS", chunkReq.searchType === "CHUNKS" && chunkReq.verbose === true);

// --- searchCodingRules parse ---
const rules = await cognee.searchCodingRules(cog, creds, { datasetName: DS, nodeset: "coding_agent_rules" });
ok("coding rules parsed", JSON.stringify(rules) === JSON.stringify(["Do not add new deps", "Use pg not mysql"]));
const rulesReq = JSON.parse(lastTo("/api/v1/search").raw);
ok("coding rules request nodeName", Array.isArray(rulesReq.nodeName) && rulesReq.nodeName[0] === "coding_agent_rules");

// --- recallWithSession: sessionId camelCase ---
await cognee.recallWithSession(cog, creds, { datasetName: DS, query: "add redis", sessionId: "sess-1", searchType: "GRAPH_COMPLETION_COT" });
const rec = JSON.parse(lastTo("/api/v1/recall").raw);
ok("recall body has sessionId(camel)+searchType", rec.sessionId === "sess-1" && rec.searchType === "GRAPH_COMPLETION_COT");

// --- getSessionQAs parse ---
const qas = await cognee.getSessionQAs(cog, creds, "sess-1");
ok("session QAs parsed qaId/question", qas[0]?.qaId === "qa-1" && qas[0]?.question.startsWith("Does this pull request"));

// --- addFeedback: snake_case body ---
await cognee.addFeedback(cog, creds, { datasetName: DS, sessionId: "sess-1", qaId: "qa-1", score: 5 });
const fb = JSON.parse(lastTo("/api/v1/remember/entry").raw);
ok("addFeedback snake_case qa_id/feedback_score/session_id/dataset_name", fb.entry.qa_id === "qa-1" && fb.entry.feedback_score === 5 && fb.session_id === "sess-1" && fb.dataset_name === DS && fb.entry.type === "feedback");

// --- improve: camelCase ---
await cognee.improve(cog, creds, { datasetName: DS, sessionIds: ["sess-1"] });
const imp = JSON.parse(lastTo("/api/v1/improve").raw);
ok("improve camelCase datasetName/sessionIds", imp.datasetName === DS && JSON.stringify(imp.sessionIds) === JSON.stringify(["sess-1"]));

// --- getDatasetId + visualize + forget ---
ok("getDatasetId resolves name→uuid", (await cognee.getDatasetId(cog, creds, DS)) === "ds-uuid");
ok("visualize returns HTML", (await cognee.visualize(cog, creds, "ds-uuid")) === "<html>graph</html>");
await cognee.forget(cog, creds, DS);
ok("forget body {dataset}", JSON.parse(lastTo("/api/v1/forget").raw).dataset === DS);

// ============ pipeline + lifecycle (real Postgres + mock Cognee, LLM-free paths) ============
const INST = 900100;
await db.initSchema();
await db.deleteInstallation(INST).catch(() => {});
await db.upsertInstallation({ installationId: INST, githubAccount: "acme", datasetName: DS, cogneeApiKey: "apikey-1" });
const inst = await db.getInstallation(INST);

// pipeline.ask (GRAPH_COMPLETION → firstAnswer)
ok("pipeline.ask returns cited answer", (await pipeline.ask(inst, creds, "why did we drop redis")) === "Because redis added ops burden.");
// primitives.ask via resolved tenant
const tenant = await tenantMod.resolveTenant({ platform: "github", externalId: String(INST) });
ok("resolveTenant(github) resolves", tenant?.installationId === INST && tenant?.datasetName === DS);
ok(
  "unlinked Slack workspace cannot resolve",
  (await tenantMod.resolveTenant({ platform: "slack", externalId: "T-unlinked" })) === null,
);
await db.linkTenant("slack", "T-linked", INST);
const linkedSlack = await tenantMod.resolveTenant({ platform: "slack", externalId: "T-linked" });
ok(
  "linked Slack workspace resolves the same isolated memory",
  linkedSlack?.installationId === INST && linkedSlack?.datasetName === DS,
);
await db.linkTenant("linear", "L-linked", INST);
const linkedLinear = await tenantMod.resolveTenant({ platform: "linear", externalId: "L-linked" });
ok(
  "linked Linear workspace resolves the same isolated memory",
  linkedLinear?.installationId === INST && linkedLinear?.datasetName === DS,
);
const standaloneRef = { platform: "slack", externalId: "T-standalone" };
const registrationsBefore = seen.filter((request) => request.path === "/api/v1/auth/register").length;
const standalone = await tenantMod.provisionAndLink(standaloneRef, "slack:Standalone");
ok(
  "standalone Slack workspace provisions isolated memory",
  standalone.installationId !== INST && standalone.inst.githubAccount === "slack:Standalone",
);
const standaloneAgain = await tenantMod.provisionAndLink(standaloneRef, "slack:Standalone");
const registrationsAfter = seen.filter((request) => request.path === "/api/v1/auth/register").length;
ok("standalone provisioning is idempotent", standaloneAgain.installationId === standalone.installationId);
ok("idempotent provisioning creates one Cognee tenant", registrationsAfter === registrationsBefore + 1);
await tenantMod.linkTenant(standaloneRef, INST);
const relinkedSlack = await tenantMod.resolveTenant(standaloneRef);
ok("Slack workspace can be relinked to existing memory", relinkedSlack?.installationId === INST);
await db.deleteInstallation(standalone.installationId);
ok("primitives.ask over tenant", (await prim.ask(tenant, "why redis")) === "Because redis added ops burden.");
// matchRules (listRules via CODING_RULES + grounding gate)
// needs >=2 shared >=3-char terms with a rule; "add new deps" overlaps "Do not add new deps"
const matched = await pipeline.matchRules(inst, tenant.cfg, creds, "this PR will add new deps to the project");
ok("matchRules grounds PR text against seeded rules", matched.includes("Do not add new deps"), JSON.stringify(matched));

// FULL feedback loop: delivery(session) → recordThreadFeedback → drain → runImprove → improve
await db.upsertDelivery({ installationId: INST, repo: "acme/a", prNumber: 7, kind: "pr", headSha: "h", decisionId: "PR-42", sessionId: "sess-1", state: "posted" });
const recorded = await lifecycle.recordThreadFeedback(inst, "acme/a", 7, 5);
ok("recordThreadFeedback found session + submitted", recorded === true);
const fb2 = JSON.parse(lastTo("/api/v1/remember/entry").raw);
ok("feedback attached to matched qa (qa-1, score 5)", fb2.entry.qa_id === "qa-1" && fb2.entry.feedback_score === 5);
const beforeDrain = await db.drainFeedbackPending();
// recordThreadFeedback should have queued sess-1 — but we just drained; re-record to test runImprove path cleanly
await db.recordFeedbackPending(INST, "sess-1");
await lifecycle.runImprove();
const impReq = JSON.parse(lastTo("/api/v1/improve").raw);
ok("runImprove called /improve with the tenant's sessions", impReq.datasetName === DS && impReq.sessionIds.includes("sess-1"));
ok("feedback_pending drained after improve", (await db.drainFeedbackPending()).size === 0);
ok("recordThreadFeedback had queued the session (pre-drain)", beforeDrain.get(INST)?.includes("sess-1") === true);

await db.deleteInstallation(INST);
server.close();
console.log(`\n=== cognee+lifecycle integration: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
