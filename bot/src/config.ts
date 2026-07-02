import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export type LlmProvider = "google" | "openai" | "deepseek";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  cogneeBaseUrl: process.env.COGNEE_BASE_URL ?? "http://127.0.0.1:8000",
  secret: required("CODEGUARD_SECRET"), // encrypts stored per-tenant Cognee API keys
  github: {
    appId: required("GITHUB_APP_ID"),
    privateKey: required("GITHUB_PRIVATE_KEY"),
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
  },
};
