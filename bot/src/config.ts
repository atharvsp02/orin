import "dotenv/config";
import { readFileSync } from "node:fs";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

// GitHub App private key: from a .pem file path (preferred — avoids multi-line PEM in .env) or inline.
function githubPrivateKey(): string {
  const path = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (path) return readFileSync(path, "utf8");
  return required("GITHUB_PRIVATE_KEY");
}

export type LlmProvider = "google" | "openai" | "deepseek" | "openrouter";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  cogneeBaseUrl: process.env.COGNEE_BASE_URL ?? "http://127.0.0.1:8000",
  secret: required("ORIN_SECRET"), // encrypts stored per-tenant Cognee API keys
  adminToken: process.env.ADMIN_TOKEN, // optional: gates preflight-key issuance until the dashboard exists
  // optional: fallback tenant for non-GitHub adapters (Slack/Linear) before an OAuth link exists
  defaultInstallationId: process.env.ORIN_DEFAULT_INSTALLATION
    ? Number(process.env.ORIN_DEFAULT_INSTALLATION)
    : undefined,
  github: {
    appId: required("GITHUB_APP_ID"),
    privateKey: githubPrivateKey(),
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
  },
  // Dashboard sign-in (GitHub OAuth). Optional: auth routes 404 until both are set.
  oauth: {
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  },
  webOrigin: process.env.WEB_ORIGIN ?? "https://orin-seven.vercel.app",
};
