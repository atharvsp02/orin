// Client for the Orin dashboard API. Same-origin via the /v1 rewrite proxy, so the session
// cookie rides along automatically. Every function returns real server data; no mocks.

export interface Me {
  login: string;
  avatar: string;
  installations: Array<{ installationId: number; account: string; decisions: number }>;
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
  updatedAt: string;
}

export interface Overview {
  account: string;
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
  overview: (inst: number) => req<Overview>(`/v1/dash/${inst}/overview`),
  decisions: (inst: number) => req<{ decisions: Decision[] }>(`/v1/dash/${inst}/decisions`),
  keys: (inst: number) => req<{ keys: KeyRow[] }>(`/v1/dash/${inst}/keys`),
  mintKey: (inst: number, repo: string, label: string) =>
    req<{ key: string; repo: string }>(`/v1/dash/${inst}/keys`, { method: "POST", body: JSON.stringify({ repo, label }) }),
  revokeKey: (inst: number, keyHash: string) =>
    req<{ revoked: boolean }>(`/v1/dash/${inst}/keys/${keyHash}`, { method: "DELETE" }),
  settings: (inst: number) => req<Settings>(`/v1/dash/${inst}/settings`),
  saveSettings: (inst: number, patch: Partial<Settings>) =>
    req<Settings>(`/v1/dash/${inst}/settings`, { method: "PUT", body: JSON.stringify(patch) }),
  graphUrl: (inst: number) => `/v1/dash/${inst}/graph`,
  signInUrl: "/v1/auth/github",
  logoutUrl: "/v1/auth/logout",
};

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
