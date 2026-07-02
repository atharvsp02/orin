// Platform-neutral tenant resolution. GitHub short-circuits to its numeric installation id
// (zero migration); Slack/Linear resolve through tenant_links, with a dev/demo fallback.
import { config } from "./config.js";
import * as db from "./db.js";
import type { Installation, TenantConfig } from "./types.js";
import type { TenantCredentials } from "./cognee.js";

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

/** Resolve a platform reference to the tenant bundle (installation + creds + config), or null. */
export async function resolveTenant(ref: TenantRef): Promise<Tenant | null> {
  let installationId: number | null =
    ref.platform === "github" ? Number(ref.externalId) : await db.resolveLink(ref.platform, ref.externalId);
  if ((installationId == null || Number.isNaN(installationId)) && config.defaultInstallationId != null) {
    installationId = config.defaultInstallationId;
  }
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
