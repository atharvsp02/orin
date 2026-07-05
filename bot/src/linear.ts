// Orin Linear adapter — agent sessions + issue-create collision-warn, thin over the core.
// On AgentSessionEvent(created|prompted): ack fast, emit a `thought`, then a cited `response`.
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { LinearClient } from "@linear/sdk";
import { resolveTenant } from "./tenant.js";
import type { Tenant } from "./tenant.js";
import * as prim from "./primitives.js";

// Narrow facade over the two SDK methods we use (the generated types are unwieldy; runtime-verified).
interface Linear {
  createAgentActivity(input: { agentSessionId: string; content: Record<string, unknown> }): Promise<unknown>;
  createComment(input: { issueId: string; body: string }): Promise<unknown>;
}

interface AgentSession {
  id: string;
  issue?: { id?: string; title?: string; description?: string };
  comment?: { body?: string };
}
interface AgentSessionWebhook {
  type: "AgentSessionEvent";
  action: "created" | "prompted";
  agentSession: AgentSession;
  organizationId?: string;
  agentActivity?: { content?: { body?: string } };
}
interface IssueWebhook {
  type: "Issue";
  action: "create" | "update" | "remove";
  data: { id: string; title?: string; description?: string };
  organizationId?: string;
}
type Webhook = AgentSessionWebhook | IssueWebhook | { type: string };

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Linear adapter needs ${name}`);
  return v;
}

const linearTenant = (orgId?: string): Promise<Tenant | null> =>
  resolveTenant({ platform: "linear", externalId: orgId ?? "" });

async function handleSession(client: Linear, wh: AgentSessionWebhook): Promise<void> {
  const sessionId = wh.agentSession.id;
  const tenant = await linearTenant(wh.organizationId);
  const thought = (body: string) => client.createAgentActivity({ agentSessionId: sessionId, content: { type: "thought", body } });
  const respond = (body: string) => client.createAgentActivity({ agentSessionId: sessionId, content: { type: "response", body } });

  if (!tenant) {
    await respond("Orin isn't linked to a repo for this Linear workspace yet.");
    return;
  }
  await thought("Searching past decisions in memory…").catch(() => undefined);

  const s = wh.agentSession;
  const text = [s.issue?.title, s.issue?.description, s.comment?.body, wh.agentActivity?.content?.body]
    .filter(Boolean)
    .join("\n\n");
  const [answer, j] = await Promise.all([prim.ask(tenant, text), prim.warn(tenant, text)]);
  const body =
    j.matches && j.comment
      ? `⚠️ ${j.comment}${answer ? `\n\n${answer}` : ""}`
      : answer || "No relevant past decision found in memory.";
  await respond(body);
}

async function handleIssueCreate(client: Linear, wh: IssueWebhook): Promise<void> {
  const tenant = await linearTenant(wh.organizationId);
  if (!tenant) return;
  const j = await prim.warn(tenant, `${wh.data.title ?? ""}\n\n${wh.data.description ?? ""}`);
  if (j.matches && j.comment) await client.createComment({ issueId: wh.data.id, body: `⚠️ ${j.comment}` });
}

function verify(secret: string, raw: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function main(): Promise<void> {
  const secret = reqEnv("LINEAR_WEBHOOK_SECRET");
  const client = new LinearClient({ accessToken: reqEnv("LINEAR_ACCESS_TOKEN") }) as unknown as Linear;
  const port = Number(process.env.LINEAR_PORT ?? 3002);

  createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let len = 0;
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      len += c.length;
      if (len > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      // HMAC over the exact received bytes — decoding chunk-by-chunk would corrupt multibyte UTF-8.
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!verify(secret, raw, req.headers["linear-signature"] as string ?? "")) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad signature" }));
        return;
      }
      // Ack within Linear's window, then process out of band.
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      let wh: Webhook;
      try {
        wh = JSON.parse(raw) as Webhook;
      } catch {
        return;
      }
      void (async () => {
        try {
          if (wh.type === "AgentSessionEvent") {
            const e = wh as AgentSessionWebhook;
            if (e.action === "created" || e.action === "prompted") await handleSession(client, e);
          } else if (wh.type === "Issue" && (wh as IssueWebhook).action === "create") {
            await handleIssueCreate(client, wh as IssueWebhook);
          }
        } catch (err) {
          console.error("linear: processing failed:", (err as Error).message);
        }
      })();
    });
  }).listen(port, () => console.log(`orin-linear listening on :${port}`));
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("linear.js") || entry.endsWith("linear.ts")) {
  main().catch((e) => {
    console.error(`orin-linear: ${(e as Error).message}`);
    process.exit(2);
  });
}
