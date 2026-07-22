// Client for the Orin dashboard API. Same-origin via the /v1 rewrite proxy, so the session
// cookie rides along automatically. Every function returns real server data; no mocks.

export interface Me {
  userId: string;
  provider?: "github" | "slack" | "linear";
  login: string;
  displayName: string;
  email: string;
  avatar: string;
  workspaces: WorkspaceSummary[];
  installations: Array<{ installationId: number; account: string; decisions: number }>;
}

export interface AuthProviders {
  github: boolean;
  slack: boolean;
  linear: boolean;
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
  role: WorkspaceRole;
  permissions: WorkspacePermission[];
  hasGitHubCompatibility: boolean;
  connectors: ConnectorSummary[];
}

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
export type WorkspacePermission =
  | "workspace.read"
  | "search.use"
  | "chat.use"
  | "connectors.read"
  | "connectors.manage"
  | "content.manage"
  | "people.manage"
  | "policies.manage"
  | "settings.manage"
  | "audit.read";

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
    aclStatus?: "current" | "stale" | "failed";
    aclSyncedAt?: string;
  }>;
  metrics: Metrics;
  recent: Catch[];
  repos: string[]; // repos that already have recorded decisions
  installedRepos: string[]; // repos the App is installed on (live from GitHub)
  links: Array<{ platform: string; externalId: string }>;
  syncs: ConnectorSync[];
}

export interface ConnectorSync {
  runId: string;
  workspaceId: string;
  connectorId: string;
  status: "running" | "succeeded" | "failed" | "partial";
  cursorValue: string;
  itemsSeen: number;
  itemsWritten: number;
  itemsDeleted: number;
  errorText: string;
  startedAt: string;
  heartbeatAt?: string;
  finishedAt?: string;
}

export interface SearchResult {
  itemId: string;
  connectorId: string;
  resourceId?: string;
  provider: string;
  sourceType: string;
  title: string;
  snippet: string;
  url: string;
  mimeType: string;
  score: number;
  sourceUpdatedAt?: string;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: "active" | "suspended";
  displayName?: string;
  primaryEmail?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceGroup {
  groupId: string;
  workspaceId: string;
  displayName: string;
  externalId?: string;
  memberCount: number;
  memberIds: string[];
  createdAt: string;
}

export interface PermissionGrant {
  grantId: string;
  workspaceId: string;
  principalType: "role" | "user" | "group";
  principalId: string;
  permission: WorkspacePermission;
  effect: "allow" | "deny";
  conditions: Record<string, string | string[]>;
}

export interface ConnectorPolicy {
  policyId: string;
  workspaceId: string;
  connectorId: string;
  effect: "include" | "exclude";
  field: "provider" | "resourceId" | "owner" | "mimeType" | "path" | "sourceType";
  operator: "equals" | "contains" | "starts_with" | "one_of";
  values: string[];
  enabled: boolean;
}

export interface AuditEvent {
  eventId: string;
  workspaceId: string;
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: "success" | "denied" | "failure";
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ChatThread {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations: SearchResult[];
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
  authProviders: () => req<{ providers: AuthProviders }>("/v1/auth/providers"),
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
  search: (workspaceId: string, query: string, provider?: string) =>
    req<{ results: SearchResult[] }>(workspacePath(workspaceId, "search"), {
      method: "POST",
      body: JSON.stringify({ query, provider }),
    }),
  ask: (workspaceId: string, question: string, threadId?: string) =>
    req<{ threadId: string; answer: string; citations: SearchResult[] }>(workspacePath(workspaceId, "chat"), {
      method: "POST",
      body: JSON.stringify({ question, threadId }),
    }),
  chatThreads: (workspaceId: string) =>
    req<{ threads: ChatThread[] }>(workspacePath(workspaceId, "chat")),
  chatMessages: (workspaceId: string, threadId: string) =>
    req<{ threadId: string; messages: ChatMessage[] }>(`${workspacePath(workspaceId, "chat")}/${threadId}`),
  people: (workspaceId: string) => req<{ people: WorkspaceMember[] }>(workspacePath(workspaceId, "people")),
  invitePerson: (workspaceId: string, email: string, displayName: string, role: WorkspaceRole) =>
    req<WorkspaceMember>(workspacePath(workspaceId, "people"), {
      method: "POST",
      body: JSON.stringify({ email, displayName, role }),
    }),
  updatePerson: (workspaceId: string, userId: string, patch: { role?: WorkspaceRole; status?: "active" | "suspended" }) =>
    req<WorkspaceMember>(`${workspacePath(workspaceId, "people")}/${userId}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  groups: (workspaceId: string) => req<{ groups: WorkspaceGroup[] }>(workspacePath(workspaceId, "groups")),
  createGroup: (workspaceId: string, displayName: string, externalId?: string) =>
    req<WorkspaceGroup>(workspacePath(workspaceId, "groups"), {
      method: "POST",
      body: JSON.stringify({ displayName, externalId }),
    }),
  setGroupMembers: (workspaceId: string, groupId: string, userIds: string[]) =>
    req<{ groupId: string; memberIds: string[] }>(`${workspacePath(workspaceId, "groups")}/${groupId}`, {
      method: "PUT",
      body: JSON.stringify({ userIds }),
    }),
  deleteGroup: (workspaceId: string, groupId: string) =>
    req<{ deleted: boolean }>(`${workspacePath(workspaceId, "groups")}/${groupId}`, { method: "DELETE" }),
  permissionGrants: (workspaceId: string) => req<{ grants: PermissionGrant[] }>(workspacePath(workspaceId, "policies")),
  createPermissionGrant: (workspaceId: string, input: Omit<PermissionGrant, "grantId" | "workspaceId">) =>
    req<PermissionGrant>(workspacePath(workspaceId, "policies"), { method: "POST", body: JSON.stringify(input) }),
  deletePermissionGrant: (workspaceId: string, grantId: string) =>
    req<{ deleted: boolean }>(`${workspacePath(workspaceId, "policies")}/${grantId}`, { method: "DELETE" }),
  auditEvents: (workspaceId: string) => req<{ events: AuditEvent[] }>(workspacePath(workspaceId, "audit")),
  syncs: (workspaceId: string) => req<{ syncs: ConnectorSync[] }>(workspacePath(workspaceId, "syncs")),
  syncConnector: (workspaceId: string, connectorId: string) =>
    req<{ accepted: boolean; jobId: string | null }>(`${workspacePath(workspaceId, "syncs")}/${connectorId}`, { method: "POST" }),
  connectorPolicies: (workspaceId: string, connectorId?: string) =>
    req<{ policies: ConnectorPolicy[] }>(`${workspacePath(workspaceId, "connectorpolicies")}${connectorId ? `?connectorId=${encodeURIComponent(connectorId)}` : ""}`),
  createConnectorPolicy: (workspaceId: string, input: Omit<ConnectorPolicy, "policyId" | "workspaceId" | "enabled">) =>
    req<ConnectorPolicy>(workspacePath(workspaceId, "connectorpolicies"), { method: "POST", body: JSON.stringify(input) }),
  deleteConnectorPolicy: (workspaceId: string, policyId: string) =>
    req<{ deleted: boolean }>(`${workspacePath(workspaceId, "connectorpolicies")}/${policyId}`, { method: "DELETE" }),
  disconnectGoogleDrive: (workspaceId: string, connectorId: string) =>
    req<{ disconnected: boolean }>(`${workspacePath(workspaceId, "disconnects")}/${connectorId}`, { method: "DELETE" }),
  googleDriveConnectUrl: (workspaceId: string) => `/v1/connectors/google-drive/start?workspaceId=${encodeURIComponent(workspaceId)}`,
  signInUrls: {
    github: "/v1/auth/github",
    slack: "/v1/auth/slack",
    linear: "/v1/auth/linear",
  },
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
