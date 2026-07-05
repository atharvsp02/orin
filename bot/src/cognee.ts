// Thin REST client for a self-hosted Cognee OSS engine in EBAC (multi-tenant) mode.
// Endpoints + casing verified live against cognee 1.2.2 (Jul 2 2026):
//   recall/search/improve = camelCase; remember/entry = snake_case; /remember form fields = snake.
// Requires Node >= 20 (global fetch / FormData / Blob).

export interface CogneeConfig {
  baseUrl: string;
}

export interface TenantCredentials {
  apiKey: string; // non-expiring X-Api-Key
  tenantId: string;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`cognee ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const keyHeader = (creds: TenantCredentials) => ({ "X-Api-Key": creds.apiKey });

/** Provision an isolated tenant for a GitHub App installation; returns a reusable X-Api-Key. */
export async function provisionTenant(
  cfg: CogneeConfig,
  opts: { email: string; password: string; tenantName: string; keyName?: string },
): Promise<TenantCredentials> {
  const { baseUrl } = cfg;
  await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: opts.email, password: opts.password, is_verified: true }),
  });
  const login = await asJson<{ access_token: string }>(
    await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: opts.email, password: opts.password }),
    }),
  );
  const bearer = { Authorization: `Bearer ${login.access_token}` };
  const tenant = await asJson<{ tenant_id: string }>(
    await fetch(`${baseUrl}/api/v1/permissions/tenants?tenant_name=${encodeURIComponent(opts.tenantName)}`, {
      method: "POST",
      headers: bearer,
    }),
  );
  const key = await asJson<{ key: string }>(
    await fetch(`${baseUrl}/api/v1/auth/api-keys`, {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ name: opts.keyName ?? "orin" }),
    }),
  );
  return { apiKey: key.key, tenantId: tenant.tenant_id };
}

/** Ingest content into a dataset (add + cognify). `/remember` is multipart; form fields are snake_case. */
export async function remember(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: { datasetName: string; filename: string; content: string | Uint8Array; nodeSet?: string; ontologyKey?: string },
): Promise<unknown> {
  const form = new FormData();
  form.append("data", new Blob([opts.content]), opts.filename);
  form.append("datasetName", opts.datasetName);
  form.append("run_in_background", "false");
  if (opts.nodeSet) form.append("node_set", opts.nodeSet); // e.g. "coding_agent_rules" to seed a rule
  if (opts.ontologyKey) form.append("ontology_key", opts.ontologyKey); // ground extraction with an uploaded OWL
  return asJson(await fetch(`${cfg.baseUrl}/api/v1/remember`, { method: "POST", headers: keyHeader(creds), body: form }));
}

/** Upload an OWL ontology (multipart). `ontologyKey` is then referenced by remember/cognify. */
export async function uploadOntology(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: { ontologyKey: string; filename: string; content: string; description?: string },
): Promise<unknown> {
  const form = new FormData();
  form.append("ontology_key", opts.ontologyKey);
  form.append("ontology_file", new Blob([opts.content]), opts.filename);
  if (opts.description) form.append("description", opts.description);
  return asJson(await fetch(`${cfg.baseUrl}/api/v1/ontologies`, { method: "POST", headers: keyHeader(creds), body: form }));
}

export type SearchType =
  | "GRAPH_COMPLETION"
  | "GRAPH_COMPLETION_COT"
  | "CHUNKS"
  | "RAG_COMPLETION"
  | "TEMPORAL"
  | "CODING_RULES";

/** Query the graph (`/search`, camelCase). Use CHUNKS+verbose for scores, includeReferences for citations. */
export async function search(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: {
    datasetName: string;
    query: string;
    searchType?: SearchType;
    includeReferences?: boolean;
    verbose?: boolean;
    topK?: number;
    nodeName?: string[];
  },
): Promise<unknown> {
  return asJson(
    await fetch(`${cfg.baseUrl}/api/v1/search`, {
      method: "POST",
      headers: { ...keyHeader(creds), "Content-Type": "application/json" },
      body: JSON.stringify({
        searchType: opts.searchType ?? "GRAPH_COMPLETION",
        query: opts.query,
        datasets: [opts.datasetName],
        includeReferences: opts.includeReferences ?? false,
        verbose: opts.verbose ?? false,
        ...(opts.topK ? { topK: opts.topK } : {}),
        ...(opts.nodeName ? { nodeName: opts.nodeName } : {}),
      }),
    }),
  );
}

/** Session-scoped recall (`/recall`). Records a QA entry (with used_graph_element_ids) — enables feedback. */
export async function recallWithSession(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: { datasetName: string; query: string; sessionId: string; searchType?: SearchType; topK?: number; includeReferences?: boolean },
): Promise<unknown> {
  return asJson(
    await fetch(`${cfg.baseUrl}/api/v1/recall`, {
      method: "POST",
      headers: { ...keyHeader(creds), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: opts.query,
        searchType: opts.searchType ?? "GRAPH_COMPLETION",
        datasets: [opts.datasetName],
        sessionId: opts.sessionId,
        includeReferences: opts.includeReferences ?? true,
        topK: opts.topK ?? 10,
      }),
    }),
  );
}

export interface SessionQA {
  qaId: string;
  question: string;
}

/** Read a session's QA entries (to find the qa_id to attach feedback to). */
export async function getSessionQAs(cfg: CogneeConfig, creds: TenantCredentials, sessionId: string): Promise<SessionQA[]> {
  const r = await asJson<{ qas?: Array<{ qa_id?: string; question?: string }> }>(
    await fetch(`${cfg.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: keyHeader(creds) }),
  );
  return (r.qas ?? []).map((q) => ({ qaId: q.qa_id ?? "", question: q.question ?? "" }));
}

/** Store maintainer feedback on a QA entry (`/remember/entry`, snake_case). score 1..5 (👎=1, 👍=5). */
export async function addFeedback(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: { datasetName: string; sessionId: string; qaId: string; score: 1 | 2 | 3 | 4 | 5 },
): Promise<unknown> {
  return asJson(
    await fetch(`${cfg.baseUrl}/api/v1/remember/entry`, {
      method: "POST",
      headers: { ...keyHeader(creds), "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: { type: "feedback", qa_id: opts.qaId, feedback_score: opts.score },
        session_id: opts.sessionId,
        dataset_name: opts.datasetName,
      }),
    }),
  );
}

/** Apply feedback weights + enrichment for the given sessions (`/improve`, camelCase). */
export async function improve(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: { datasetName: string; sessionIds: string[] },
): Promise<unknown> {
  return asJson(
    await fetch(`${cfg.baseUrl}/api/v1/improve`, {
      method: "POST",
      headers: { ...keyHeader(creds), "Content-Type": "application/json" },
      body: JSON.stringify({ datasetName: opts.datasetName, sessionIds: opts.sessionIds }),
    }),
  );
}

/** Fetch the coding-rules nodeset (deterministic; no LLM). Seed rules with remember({nodeSet}). */
export async function searchCodingRules(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: { datasetName: string; nodeset?: string },
): Promise<string[]> {
  const res = await search(cfg, creds, {
    datasetName: opts.datasetName,
    query: "rules",
    searchType: "CODING_RULES",
    nodeName: [opts.nodeset ?? "coding_agent_rules"],
  });
  const arr = res as Array<{ search_result?: unknown }> | undefined;
  const first = Array.isArray(arr) ? arr[0]?.search_result : undefined;
  return Array.isArray(first) ? first.map((x) => String(x)) : [];
}

/** Resolve a dataset name → its UUID (for visualize). */
export async function getDatasetId(cfg: CogneeConfig, creds: TenantCredentials, datasetName: string): Promise<string | null> {
  const rows = await asJson<Array<{ id?: string; name?: string }>>(
    await fetch(`${cfg.baseUrl}/api/v1/datasets`, { headers: keyHeader(creds) }),
  );
  const hit = rows.find((r) => r.name === datasetName) ?? rows[0];
  return hit?.id ?? null;
}

/** Interactive knowledge-graph HTML for a dataset (`/visualize`). */
export async function visualize(cfg: CogneeConfig, creds: TenantCredentials, datasetId: string): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/api/v1/visualize?dataset_id=${encodeURIComponent(datasetId)}`, {
    headers: keyHeader(creds),
  });
  if (!res.ok) throw new Error(`cognee ${res.status}`);
  return res.text();
}

export interface ScoredChunk {
  score: number; // cosine distance, lower = closer
  documentName: string;
  documentId: string;
  text: string;
}

/** CHUNKS + verbose search that surfaces per-chunk relevance scores and citation payloads. */
export async function searchChunksScored(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: { datasetName: string; query: string; topK?: number },
): Promise<ScoredChunk[]> {
  const res = await search(cfg, creds, {
    datasetName: opts.datasetName,
    query: opts.query,
    searchType: "CHUNKS",
    verbose: true,
    topK: opts.topK ?? 5,
  });
  const arr = res as Array<{
    objects_result?: Array<{ score?: number; payload?: { document_name?: string; document_id?: string; text?: string } }>;
  }>;
  const objs = Array.isArray(arr) ? (arr[0]?.objects_result ?? []) : [];
  return objs.map((o) => ({
    score: o.score ?? 1,
    documentName: o.payload?.document_name ?? "",
    documentId: o.payload?.document_id ?? "",
    text: o.payload?.text ?? "",
  }));
}

/** Prune a dataset (the live `forget()` demo). */
export async function forget(cfg: CogneeConfig, creds: TenantCredentials, datasetName: string): Promise<unknown> {
  return asJson(
    await fetch(`${cfg.baseUrl}/api/v1/forget`, {
      method: "POST",
      headers: { ...keyHeader(creds), "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: datasetName }),
    }),
  );
}
