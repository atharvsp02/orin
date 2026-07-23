process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";
delete process.env.ORIN_LLM_PROVIDER;
delete process.env.ORIN_LLM_FALLBACK_PROVIDER;

const {
  buildJudgmentPrompt,
  normalizeJudgment,
  resolveLlmFallbackProvider,
  resolveLlmModelId,
  resolveLlmProvider,
  resolveLlmProviderOrder,
  runWithLlmFallback,
} =
  await import("../dist/llm.js");

let pass = 0;
let fail = 0;
const ok = (name, condition) => {
  if (condition) pass++;
  else fail++;
  console.log(`  ${condition ? "PASS" : "FAIL"} ${name}`);
};

ok("defaults to OpenAI", resolveLlmProvider(undefined) === "openai");
ok("selects OpenAI", resolveLlmProvider("openai") === "openai");
ok("normalizes provider input", resolveLlmProvider(" OpenAI ") === "openai");
ok("defaults fallback to DeepSeek", resolveLlmFallbackProvider(undefined) === "deepseek");
ok("allows fallback to be disabled", resolveLlmFallbackProvider("none") === null);
ok(
  "orders OpenAI before DeepSeek",
  JSON.stringify(resolveLlmProviderOrder()) === JSON.stringify(["openai", "deepseek"]),
);
ok(
  "deduplicates identical primary and fallback providers",
  JSON.stringify(resolveLlmProviderOrder("openai", "openai")) === JSON.stringify(["openai"]),
);
ok("resolves a tenant OpenAI model", resolveLlmModelId("openai").startsWith("openai:"));
ok("resolves a tenant DeepSeek model", resolveLlmModelId("deepseek").startsWith("deepseek:"));

let invalidProviderRejected = false;
try {
  resolveLlmProvider("invalid");
} catch {
  invalidProviderRejected = true;
}
ok("rejects unsupported providers", invalidProviderRejected);
let invalidFallbackRejected = false;
try {
  resolveLlmFallbackProvider("invalid");
} catch {
  invalidFallbackRejected = true;
}
ok("rejects an unsupported fallback provider", invalidFallbackRejected);

const primaryCalls = [];
const primaryResult = await runWithLlmFallback(["openai", "deepseek"], async (provider) => {
  primaryCalls.push(provider);
  return "primary";
});
ok("uses only OpenAI when the primary succeeds", primaryResult === "primary"
  && JSON.stringify(primaryCalls) === JSON.stringify(["openai"]));

const fallbackCalls = [];
const fallbackResult = await runWithLlmFallback(["openai", "deepseek"], async (provider) => {
  fallbackCalls.push(provider);
  if (provider === "openai") throw new Error("OpenAI unavailable");
  return "fallback";
});
ok("uses DeepSeek after an OpenAI failure", fallbackResult === "fallback"
  && JSON.stringify(fallbackCalls) === JSON.stringify(["openai", "deepseek"]));

let bothProvidersRejected = false;
try {
  await runWithLlmFallback(["openai", "deepseek"], async () => {
    throw new Error("provider unavailable");
  });
} catch (error) {
  bothProvidersRejected = error instanceof AggregateError && error.errors.length === 2;
}
ok("fails when OpenAI and DeepSeek both fail", bothProvidersRejected);

const candidates = [
  {
    decisionId: "ISSUE-1",
    title: "Reject Redis as a required session cache",
    outcome: "rejected",
    reasoning: "PostgreSQL is sufficient and another cache would complicate operations.",
    terms: ["Redis", "ioredis", "REDIS_URL", "PostgreSQL"],
    url: "https://github.com/acme/repo/issues/1",
  },
];
const judgmentPrompt = buildJudgmentPrompt(
  "Add RabbitMQ through amqplib and AMQP_URL for background jobs.",
  candidates,
  "",
  "",
);
ok("judgment prompt includes candidate terms", judgmentPrompt.includes("Redis, ioredis, REDIS_URL, PostgreSQL"));
ok("judgment prompt rejects broad-category matching", judgmentPrompt.includes("broad category"));
ok("judgment prompt distinguishes different technologies", judgmentPrompt.includes("Different technologies are not a match"));
ok("judgment prompt uses proposal-neutral language", judgmentPrompt.includes("A new change proposal"));

ok(
  "normalizes a valid judgment",
  normalizeJudgment(
    { matches: true, decisionId: "ISSUE-1", comment: "This reintroduces Redis." },
    candidates,
  ).matches,
);
ok(
  "rejects an unavailable decision reference",
  !normalizeJudgment(
    { matches: true, decisionId: "ISSUE-99", comment: "This reintroduces Redis." },
    candidates,
  ).matches,
);
ok(
  "rejects a finding without an explanation",
  !normalizeJudgment({ matches: true, decisionId: "ISSUE-1", comment: "  " }, candidates).matches,
);
const normalizedClear = normalizeJudgment(
  { matches: false, decisionId: "ISSUE-1", comment: "stale text" },
  candidates,
);
ok("clears stale fields on a non-match", normalizedClear.decisionId === null && normalizedClear.comment === "");

console.log(`\n=== llm.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
