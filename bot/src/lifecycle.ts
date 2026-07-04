// Cognee lifecycle glue: the maintainer-feedback → improve → forget half of the four-verb loop.
// (remember + recall live in pipeline.ts / worker.ts; this is the learning + teardown side.)
import { config } from "./config.js";
import * as db from "./db.js";
import * as cognee from "./cognee.js";
import { CATCH_QUESTION, submitFeedback, improveTenant } from "./pipeline.js";
import type { TenantCredentials } from "./cognee.js";
import type { Installation } from "./types.js";

const cog = { baseUrl: config.cogneeBaseUrl };
const credsFor = (inst: Installation): TenantCredentials => ({ apiKey: inst.cogneeApiKey, tenantId: "" });

/**
 * Attach a maintainer 👍/👎 to the recall QA that produced CodeGuard's verdict on this thread,
 * and mark the session pending so the hourly improve worker reweights the exact graph nodes.
 * Returns false when there is no recorded catch session to score.
 */
export async function recordThreadFeedback(
  inst: Installation,
  repo: string,
  number: number,
  score: 1 | 2 | 3 | 4 | 5,
): Promise<boolean> {
  const sessionId = await db.getPrSession(inst.installationId, repo, number);
  if (!sessionId) return false;
  // A clear thread (or a transient Cognee error) yields no QA to score — contain it and report "nothing to score".
  const scored = await submitFeedback(credsFor(inst), {
    datasetName: inst.datasetName,
    sessionId,
    question: CATCH_QUESTION,
    score,
  }).catch(() => false);
  if (!scored) return false;
  await db.recordFeedbackPending(inst.installationId, sessionId);
  return true;
}

/** Hourly worker: drain every session that got feedback and apply /improve per tenant.
 *  Each tenant is isolated — one tenant's Cognee failure re-queues only its own sessions,
 *  never discarding another tenant's feedback (at-least-once). */
export async function runImprove(): Promise<void> {
  const pending = await db.drainFeedbackPending();
  if (pending.size === 0) return;
  for (const [installationId, sessionIds] of pending) {
    try {
      const inst = await db.getInstallation(installationId);
      if (!inst) continue; // installation gone → drop its (now-orphaned) sessions
      await improveTenant(credsFor(inst), inst.datasetName, sessionIds);
      console.log(`improve: ${inst.datasetName} (${sessionIds.length} sessions)`);
    } catch (e) {
      console.warn(`improve failed for ${installationId}, re-queueing:`, (e as Error).message);
      for (const s of sessionIds) await db.recordFeedbackPending(installationId, s).catch(() => undefined);
    }
  }
}

/** Prune a tenant's whole decision graph (the live forget() verb). */
export async function forgetTenant(inst: Installation): Promise<void> {
  await cognee.forget(cog, credsFor(inst), inst.datasetName);
}
