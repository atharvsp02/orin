import * as content from "./content-db.js";
import * as db from "./db.js";
import * as enterprise from "./enterprise-db.js";
import { installationOctokit } from "./github.js";
import type { ConnectorAccount, ConnectorResource } from "./connectors.js";
import type { GithubSyncJob } from "./queues.js";
import type { DecisionRecord } from "./types.js";

type Gh = Awaited<ReturnType<typeof installationOctokit>>;

interface GithubRepositoryAccess {
  connector: ConnectorAccount;
  resource: ConnectorResource;
}

function repositoryParts(repo: string): [string, string] {
  const [owner, name, ...rest] = repo.trim().split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`invalid GitHub repository: ${repo}`);
  return [owner, name];
}

export function githubDecisionExternalId(record: Pick<DecisionRecord, "repo" | "decisionId">): string {
  return `decision:${record.repo}:${record.decisionId}`;
}

export function githubDecisionBody(record: DecisionRecord): string {
  return [
    `Decision: ${record.decisionId}`,
    `Outcome: ${record.outcome}`,
    `Title: ${record.title}`,
    `Reasoning: ${record.reasoningText}`,
    record.terms.length ? `Key terms: ${record.terms.join(", ")}` : "",
    record.supersededBy ? `Superseded by: ${record.supersededBy}` : "",
    `Repository: ${record.repo}`,
  ].filter(Boolean).join("\n");
}

export function githubRepositoryAcls(
  visibility: string | undefined,
  isPrivate: boolean,
  collaborators: Array<{ login?: string | null }>,
): content.ContentAcl[] {
  const isPublic = visibility === "public" || (visibility === undefined && !isPrivate);
  if (isPublic) return [{ principalType: "anyone", principalKey: "*" }];
  return [...new Set(
    collaborators
      .map((collaborator) => collaborator.login?.trim().toLowerCase() ?? "")
      .filter(Boolean),
  )].map((login) => ({ principalType: "github_login", principalKey: login }));
}

export async function syncGithubRepositoryAccess(
  installationId: number,
  repo: string,
  clientInput?: Gh,
): Promise<GithubRepositoryAccess | null> {
  const connector = await db.getConnector("github", String(installationId));
  if (!connector || connector.status === "disabled") return null;
  let resource = await db.getConnectorResource(connector.connectorId, "repository", repo);
  resource ??= await db.upsertConnectorResource({
    connectorId: connector.connectorId,
    externalId: repo,
    kind: "repository",
    displayName: repo,
  });
  if (!resource.enabled) return null;
  try {
    const [owner, name] = repositoryParts(repo);
    const client = clientInput ?? await installationOctokit(installationId);
    const repository = await client.rest.repos.get({ owner, repo: name });
    const isPublic = repository.data.visibility === "public" ||
      (repository.data.visibility === undefined && repository.data.private === false);
    const collaborators = isPublic
      ? []
      : await client.paginate(client.rest.repos.listCollaborators, {
          owner,
          repo: name,
          affiliation: "all",
          per_page: 100,
        });
    await content.replaceConnectorResourceMemberships(
      connector.workspaceId,
      resource.resourceId,
      githubRepositoryAcls(repository.data.visibility, repository.data.private, collaborators),
    );
    resource = await db.getConnectorResource(connector.connectorId, "repository", repo) ?? resource;
    return { connector, resource };
  } catch (error) {
    await content.markConnectorResourceAclStatus(connector.workspaceId, resource.resourceId, "failed");
    throw error;
  }
}

async function indexDecision(
  record: DecisionRecord,
  access: GithubRepositoryAccess,
): Promise<content.ContentItem | null> {
  const { connector, resource } = access;
  const externalId = githubDecisionExternalId(record);
  const allowed = await content.connectorContentAllowed(connector.workspaceId, connector.connectorId, {
    provider: "github",
    resourceId: record.repo,
    owner: record.repo.split("/")[0] ?? "",
    mimeType: "text/plain",
    path: record.repo,
    sourceType: "decision",
  });
  if (!allowed) {
    await content.markContentDeleted(connector.workspaceId, connector.connectorId, externalId);
    return null;
  }
  return content.upsertContentItem({
    workspaceId: connector.workspaceId,
    connectorId: connector.connectorId,
    resourceId: resource.resourceId,
    externalId,
    sourceType: "decision",
    title: `${record.decisionId}: ${record.title}`,
    body: githubDecisionBody(record),
    url: record.sourceUrl,
    mimeType: "text/plain",
    ownerKey: record.repo.split("/")[0] ?? "",
    sourcePath: record.repo,
    visibility: "restricted",
    aclStatus: "current",
    acls: [{ principalType: "resource_member", principalKey: resource.resourceId }],
    metadata: {
      decisionId: record.decisionId,
      decisionSourceType: record.sourceType,
      outcome: record.outcome,
      terms: record.terms,
      supersededBy: record.supersededBy ?? "",
    },
    sourceCreatedAt: record.decidedAt || undefined,
    sourceUpdatedAt: record.decidedAt || undefined,
  });
}

export async function indexGithubDecisionContents(
  records: DecisionRecord[],
  clientInput?: Gh,
): Promise<content.ContentItem[]> {
  const grouped = new Map<string, DecisionRecord[]>();
  for (const record of records) {
    if (!record.repo) continue;
    const key = `${record.installationId}:${record.repo}`;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  const indexed: content.ContentItem[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    const access = await syncGithubRepositoryAccess(first.installationId, first.repo, clientInput);
    if (!access) continue;
    for (const record of group) {
      const item = await indexDecision(record, access);
      if (item) indexed.push(item);
    }
  }
  return indexed;
}

export async function indexGithubDecisionContent(
  record: DecisionRecord,
  clientInput?: Gh,
): Promise<content.ContentItem | null> {
  return (await indexGithubDecisionContents([record], clientInput))[0] ?? null;
}

export async function runGithubDecisionSync(
  job: GithubSyncJob,
  clientInput?: Gh,
): Promise<{ repositories: number; written: number; failed: number }> {
  const connector = await db.getConnectorById(job.workspaceId, job.connectorId);
  if (!connector || connector.provider !== "github") throw new Error("GitHub connector not found");
  if (connector.status === "disabled") return { repositories: 0, written: 0, failed: 0 };
  const installationId = Number(connector.externalId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("invalid GitHub installation id");
  const run = await content.startConnectorSync(job.workspaceId, job.connectorId);
  let repositories = 0;
  let written = 0;
  let failed = 0;
  try {
    const resources = (await db.listConnectorResources(connector.connectorId))
      .filter((resource) => resource.kind === "repository" && resource.enabled);
    const records = job.backfill ? await db.getDecisionRecords(installationId) : [];
    const recordsByRepo = new Map<string, DecisionRecord[]>();
    for (const record of records) recordsByRepo.set(record.repo, [...(recordsByRepo.get(record.repo) ?? []), record]);
    const repos = new Set([...resources.map((resource) => resource.externalId), ...recordsByRepo.keys()]);
    for (const repo of repos) {
      const existing = resources.find((resource) => resource.externalId === repo);
      if (existing && !existing.enabled) continue;
      repositories += 1;
      try {
        const access = await syncGithubRepositoryAccess(installationId, repo, clientInput);
        if (!access) continue;
        for (const record of recordsByRepo.get(repo) ?? []) {
          if (await indexDecision(record, access)) written += 1;
        }
      } catch {
        failed += 1;
      }
    }
    if (repositories > 0 && failed === repositories) throw new Error("all GitHub repository ACL synchronizations failed");
    await content.finishConnectorSync({
      workspaceId: job.workspaceId,
      runId: run.runId,
      status: failed ? "partial" : "succeeded",
      itemsSeen: records.length,
      itemsWritten: written,
      errorText: failed ? `${failed} GitHub repositories failed closed until a successful retry` : "",
    });
    await db.setConnectorStatus(job.workspaceId, job.connectorId, "active");
    await enterprise.recordAuditEvent({
      workspaceId: job.workspaceId,
      actorUserId: job.actorUserId,
      action: "connector.sync_completed",
      targetType: "connector",
      targetId: job.connectorId,
      details: { provider: "github", backfill: job.backfill === true, repositories, written, failed },
    });
    return { repositories, written, failed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await content.finishConnectorSync({
      workspaceId: job.workspaceId,
      runId: run.runId,
      status: "failed",
      itemsWritten: written,
      errorText: message,
    });
    await content.markConnectorResourcesAclStatus(job.workspaceId, job.connectorId, "failed");
    await enterprise.recordAuditEvent({
      workspaceId: job.workspaceId,
      actorUserId: job.actorUserId,
      action: "connector.sync_failed",
      targetType: "connector",
      targetId: job.connectorId,
      outcome: "failure",
      details: { provider: "github", error: message.slice(0, 300) },
    });
    throw error;
  }
}
