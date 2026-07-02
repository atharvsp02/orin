// Thin REST client for a self-hosted Cognee OSS engine in EBAC (multi-tenant) mode.
// Endpoints + the provisioning flow were verified live against cognee 1.2.2.
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
      body: JSON.stringify({ name: opts.keyName ?? "codeguard" }),
    }),
  );

  return { apiKey: key.key, tenantId: tenant.tenant_id };
}

const keyHeader = (creds: TenantCredentials) => ({ "X-Api-Key": creds.apiKey });

/** Ingest content into a dataset (add + cognify). `/remember` is multipart. */
export async function remember(
  cfg: CogneeConfig,
  creds: TenantCredentials,
  opts: { datasetName: string; filename: string; content: string | Uint8Array },
): Promise<unknown> {
  const form = new FormData();
  form.append("data", new Blob([opts.content]), opts.filename);
  form.append("datasetName", opts.datasetName);
  form.append("run_in_background", "false");
  return asJson(await fetch(`${cfg.baseUrl}/api/v1/remember`, { method: "POST", headers: keyHeader(creds), body: form }));
}

export type SearchType = "GRAPH_COMPLETION" | "CHUNKS" | "RAG_COMPLETION" | "TEMPORAL" | "CODING_RULES";

/** Recall. Use CHUNKS+verbose for scores + citation payloads, or includeReferences for an evidence block. */
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
  },
): Promise<unknown> {
  return asJson(
    await fetch(`${cfg.baseUrl}/api/v1/search`, {
      method: "POST",
      headers: { ...keyHeader(creds), "Content-Type": "application/json" },
      body: JSON.stringify({
        search_type: opts.searchType ?? "GRAPH_COMPLETION",
        query: opts.query,
        datasets: [opts.datasetName],
        include_references: opts.includeReferences ?? false,
        verbose: opts.verbose ?? false,
        ...(opts.topK ? { top_k: opts.topK } : {}),
      }),
    }),
  );
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
