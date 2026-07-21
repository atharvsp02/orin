import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { normalizeConnectorRef, type ConnectorAccount, type ConnectorRef, type Workspace } from "./connectors.js";
import { DECISION_OWL, ONTOLOGY_KEY, ONTOLOGY_FILENAME } from "./ontology.js";
import type { Installation, TenantConfig } from "./types.js";
import type { TenantCredentials } from "./cognee.js";

const cog = { baseUrl: config.cogneeBaseUrl };

export interface Tenant {
  workspaceId: string;
  workspace: Workspace;
  connector: ConnectorAccount;
  installationId: number;
  datasetName: string;
  creds: TenantCredentials;
  cfg: TenantConfig;
  inst: Installation;
}

export async function resolveTenant(ref: ConnectorRef): Promise<Tenant | null> {
  let normalized: ConnectorRef;
  try {
    normalized = normalizeConnectorRef(ref);
  } catch {
    return null;
  }
  const connector = await db.getConnector(normalized.provider, normalized.externalId);
  if (!connector || connector.status !== "active") return null;
  const workspace = await db.getWorkspace(connector.workspaceId);
  const installationId = workspace?.legacyInstallationId;
  if (!workspace || installationId == null) return null;
  const inst = await db.getInstallation(installationId);
  if (!inst) return null;
  const cfg = await db.getTenantConfig(installationId);
  return {
    workspaceId: workspace.workspaceId,
    workspace,
    connector,
    installationId,
    datasetName: workspace.datasetName,
    creds: { apiKey: workspace.cogneeApiKey, tenantId: "" },
    cfg,
    inst,
  };
}

export async function linkTenant(ref: ConnectorRef, installationId: number): Promise<void> {
  const normalized = normalizeConnectorRef(ref);
  await db.linkTenant(normalized.provider, normalized.externalId, installationId);
}

export async function provisionAndLink(ref: ConnectorRef, displayName: string): Promise<Tenant> {
  const normalized = normalizeConnectorRef(ref);
  const existing = await resolveTenant(normalized);
  if (existing) return existing;

  const installationId = 1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000);
  const creds = await cognee.provisionTenant(cog, {
    email: `${normalized.provider}-${installationId}@orin.io`,
    password: randomBytes(18).toString("hex"),
    tenantName: `${normalized.provider}-${installationId}`,
  });
  await db.upsertInstallation({
    installationId,
    githubAccount: displayName,
    datasetName: `${normalized.provider}-${installationId}`,
    cogneeApiKey: creds.apiKey,
  });
  await cognee
    .uploadOntology(cog, creds, { ontologyKey: ONTOLOGY_KEY, filename: ONTOLOGY_FILENAME, content: DECISION_OWL })
    .catch(() => undefined);
  await db.linkTenant(normalized.provider, normalized.externalId, installationId);

  const tenant = await resolveTenant(normalized);
  if (!tenant) throw new Error("provisionAndLink: tenant resolution failed after provisioning");
  return tenant;
}
