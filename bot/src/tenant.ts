// Platform-neutral tenant resolution + self-serve provisioning. GitHub short-circuits to its
// numeric installation id (zero migration); Slack/Linear resolve through tenant_links.
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { DECISION_OWL, ONTOLOGY_KEY, ONTOLOGY_FILENAME } from "./ontology.js";
import type { Installation, TenantConfig } from "./types.js";
import type { TenantCredentials } from "./cognee.js";

const cog = { baseUrl: config.cogneeBaseUrl };

export type Platform = "github" | "slack" | "linear";
export interface TenantRef {
  platform: Platform;
  externalId: string; // GitHub installation id, Slack team id, Linear workspace/org id
}

export interface Tenant {
  installationId: number;
  datasetName: string;
  creds: TenantCredentials;
  cfg: TenantConfig;
  inst: Installation;
}

/** Resolve a platform reference to the tenant bundle (installation + creds + config), or null.
 *  Non-GitHub platforms MUST have an explicit tenant_links row — there is deliberately no silent
 *  default fallback here, so an unlinked Slack/Linear workspace can never read or poison another
 *  tenant's memory. (Local single-tenant setups insert one link row; MCP passes a GitHub ref directly.) */
export async function resolveTenant(ref: TenantRef): Promise<Tenant | null> {
  const installationId: number | null =
    ref.platform === "github" ? Number(ref.externalId) : await db.resolveLink(ref.platform, ref.externalId);
  if (installationId == null || Number.isNaN(installationId)) return null;

  const inst = await db.getInstallation(installationId);
  if (!inst) return null;
  const cfg = await db.getTenantConfig(installationId);
  return {
    installationId,
    datasetName: inst.datasetName,
    creds: { apiKey: inst.cogneeApiKey, tenantId: "" },
    cfg,
    inst,
  };
}

/** Link a Slack team / Linear workspace to an existing installation (from an OAuth install callback). */
export async function linkTenant(ref: TenantRef, installationId: number): Promise<void> {
  await db.linkTenant(ref.platform, ref.externalId, installationId);
}

/** Self-serve provisioning: give a new Slack/Linear workspace its OWN fresh isolated brain and
 *  link it. Idempotent — returns the existing tenant if the workspace is already linked.
 *  Synthetic installation ids live at 1e12+ so they can never collide with GitHub's. */
export async function provisionAndLink(ref: TenantRef, displayName: string): Promise<Tenant> {
  const existing = await resolveTenant(ref);
  if (existing) return existing;

  const installationId = 1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000);
  const creds = await cognee.provisionTenant(cog, {
    email: `${ref.platform}-${installationId}@orin.io`,
    password: randomBytes(18).toString("hex"),
    tenantName: `${ref.platform}-${installationId}`,
  });
  await db.upsertInstallation({
    installationId,
    githubAccount: displayName,
    datasetName: `${ref.platform}-${installationId}`,
    cogneeApiKey: creds.apiKey,
  });
  await cognee
    .uploadOntology(cog, creds, { ontologyKey: ONTOLOGY_KEY, filename: ONTOLOGY_FILENAME, content: DECISION_OWL })
    .catch(() => undefined); // duplicate key on re-provision is fine
  await db.linkTenant(ref.platform, ref.externalId, installationId);

  const tenant = await resolveTenant(ref);
  if (!tenant) throw new Error("provisionAndLink: tenant resolution failed after provisioning");
  return tenant;
}
