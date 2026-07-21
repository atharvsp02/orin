// Client for the Orin dashboard API. Same-origin via the /v1 rewrite proxy, so the session
// cookie rides along automatically. Every function returns real server data; no mocks.

export interface Me {
  login: string;
  avatar: string;
  workspaces: WorkspaceSummary[];
  installations: Array<{ installationId: number; account: string; decisions: number }>;
}

export type ConnectorCapability = "ingest" | "query" | "record" | "warn" | "deliver";
export type ConnectorStatus = "active" | "disabled" | "error";

export interface ConnectorSummary {
  provider: string;
  displayName: string;
  status: ConnectorStatus;
  capabilities: ConnectorCapability[];
}

export interface WorkspaceSummary {
  workspaceId: string;
  displayName: string;
  decisions: number;
  connectors: ConnectorSummary[];
}

export interface Metrics {
  prsPrevented: number;
  decisionsTracked: number;
  rejectionsActive: number;
}

export interface Catch {
  repo: string;
  number: number;
  kind: string;
  decisionId: string | null;
  state: string;
  errorText: string | null;
  updatedAt: string;
}

export interface GraphNode {
  id: string;
  type: "decision" | "term" | "repo";
  label: string;
  outcome?: string;
  title?: string;
  repo?: string;
  url?: string;
  degree?: number;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string; kind: "has-term" | "in-repo" | "supersedes" }>;
  stats: { decisions: number; entities: number };
}

export interface Overview {
  account: string;
  workspace: { workspaceId: string; displayName: string } | null;
  connectors: Array<ConnectorSummary & { connectorId: string }>;
  resources: Array<{
    resourceId: string;
    connectorId: string;
    externalId: string;
    kind: string;
    displayName: string;
    enabled: boolean;
  }>;
  metrics: Metrics;
  recent: Catch[];
  repos: string[]; // repos that already have recorded decisions
  installedRepos: string[]; // repos the App is installed on (live from GitHub)
  links: Array<{ platform: string; externalId: string }>;
}

export interface Decision {
  decisionId: string;
  repo: string;
  title: string;
  outcome: string;
  reasoning: string;
  decidedAt: string;
  supersededBy: string | null;
  sourceUrl: string;
}

export interface KeyRow {
  keyHash: string;
  repo: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface Settings {
  installationId: number;
  tone: string;
  confidenceThreshold: number;
  scoreCutoff: number;
  autoComment: boolean;
  customInstructions: string;
  llmProvider: string;
  deliveryMode: string;
  blockOnRepropose: boolean;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => req<Me>("/v1/me"),
  overview: (workspaceId: string) => req<Overview>(workspacePath(workspaceId, "overview")),
  decisions: (workspaceId: string) => req<{ decisions: Decision[] }>(workspacePath(workspaceId, "decisions")),
  keys: (workspaceId: string) => req<{ keys: KeyRow[] }>(workspacePath(workspaceId, "keys")),
  mintKey: (workspaceId: string, repo: string, label: string) =>
    req<{ key: string; repo: string }>(workspacePath(workspaceId, "keys"), { method: "POST", body: JSON.stringify({ repo, label }) }),
  revokeKey: (workspaceId: string, keyHash: string) =>
    req<{ revoked: boolean }>(`${workspacePath(workspaceId, "keys")}/${keyHash}`, { method: "DELETE" }),
  settings: (workspaceId: string) => req<Settings>(workspacePath(workspaceId, "settings")),
  saveSettings: (workspaceId: string, patch: Partial<Settings>) =>
    req<Settings>(workspacePath(workspaceId, "settings"), { method: "PUT", body: JSON.stringify(patch) }),
  graphUrl: (workspaceId: string) => workspacePath(workspaceId, "graph"),
  graphData: (workspaceId: string) => req<GraphData>(workspacePath(workspaceId, "graphdata")),
  rules: (workspaceId: string, repo?: string) =>
    req<{ rules: string[] }>(`${workspacePath(workspaceId, "rules")}${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`),
  addRule: (workspaceId: string, text: string, repo?: string) =>
    req<{ rules: string[]; indexing: boolean }>(workspacePath(workspaceId, "rules"), { method: "POST", body: JSON.stringify({ text, repo }) }),
  docs: (workspaceId: string) => req<{ docs: Array<{ filename: string; title: string; repo: string; createdAt: string }> }>(workspacePath(workspaceId, "docs")),
  uploadDoc: (workspaceId: string, title: string, content: string, extractRules: boolean, repo?: string) =>
    req<{ accepted: boolean; filename: string; rules: string[] }>(workspacePath(workspaceId, "docs"), {
      method: "POST",
      body: JSON.stringify({ title, content, extractRules, repo }),
    }),
  setConnectorEnabled: (workspaceId: string, connectorId: string, enabled: boolean) =>
    req<ConnectorSummary>(`${workspacePath(workspaceId, "connectors")}/${connectorId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  setResourceEnabled: (workspaceId: string, resourceId: string, enabled: boolean) =>
    req<{ enabled: boolean }>(`${workspacePath(workspaceId, "resources")}/${resourceId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  signInUrl: "/v1/auth/github",
  logoutUrl: "/v1/auth/logout",
};

function workspacePath(workspaceId: string, resource: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/${resource}`;
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}
