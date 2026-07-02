// Queue names + job payloads, shared by the webhook entry point, the worker, and command handling.
export const QUEUE = { ingest: "ingest", catch: "catch", command: "command" } as const;

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

export interface CommandJob {
  installationId: number;
  repo: string;
  number: number;
  commentId: number;
  body: string;
  sender: string;
  isPr: boolean;
}
