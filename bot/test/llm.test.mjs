process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";
delete process.env.ORIN_LLM_PROVIDER;

const { resolveLlmProvider } = await import("../dist/llm.js");

let pass = 0;
let fail = 0;
const ok = (name, condition) => {
  if (condition) pass++;
  else fail++;
  console.log(`  ${condition ? "PASS" : "FAIL"} ${name}`);
};

ok("defaults to DeepSeek", resolveLlmProvider(undefined) === "deepseek");
ok("selects OpenAI", resolveLlmProvider("openai") === "openai");
ok("normalizes provider input", resolveLlmProvider(" OpenAI ") === "openai");

let invalidProviderRejected = false;
try {
  resolveLlmProvider("invalid");
} catch {
  invalidProviderRejected = true;
}
ok("rejects unsupported providers", invalidProviderRejected);

console.log(`\n=== llm.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
