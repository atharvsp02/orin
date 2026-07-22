// Queue names + job payloads, shared by the webhook entry point, the worker, and command handling.
export const QUEUE = {
  ingest: "ingest",
  catch: "catch",
  command: "command",
  lifecycle: "lifecycle",
  driveSync: "drive-sync",
  linearSync: "linear-sync",
  linearWebhook: "linear-webhook",
  connectorScheduler: "connector-scheduler",
} as const;

export const CATCH_RETRY_OPTIONS = {
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
} as const;

export interface IngestJob {
  installationId: number;
  repo: string;
  number?: number; // single-item (live) ingest; omit for a full backfill
  limit?: number;
}

export interface CatchJob {
  installationId: number;
  repo: string;
  kind: "pr" | "issue";
  number: number;
}

export function safeJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  return message
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key[=:]\s*)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 300);
}

export function catchFailureRecord(data: CatchJob, error: unknown, finalAttempt: boolean) {
  return {
    installationId: data.installationId,
    repo: data.repo,
    prNumber: data.number,
    kind: data.kind,
    headSha: "",
    mode: data.kind === "issue" ? "comment" : null,
    state: finalAttempt ? "failed" : "retrying",
    errorText: safeJobError(error),
  };
}

export interface CommandJob {
  installationId: number;
  repo: string;
  number: number;
  commentId: number;
  body: string;
  sender: string;
  isPr: boolean;
}

export interface DriveSyncJob {
  workspaceId: string;
  connectorId: string;
  actorUserId?: string;
}

export interface LinearSyncJob {
  workspaceId: string;
  connectorId: string;
  actorUserId?: string;
}

export interface LinearWebhookJob {
  webhook: Record<string, unknown>;
}
