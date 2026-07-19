const { CATCH_RETRY_OPTIONS, catchFailureRecord, safeJobError } = await import("../dist/queues.js");

let pass = 0;
let fail = 0;
const ok = (name, condition) => {
  if (condition) pass++;
  else fail++;
  console.log(`  ${condition ? "PASS" : "FAIL"} ${name}`);
};

ok("catch retries are delayed", CATCH_RETRY_OPTIONS.retryDelay > 0);
ok("catch retries use backoff", CATCH_RETRY_OPTIONS.retryBackoff === true);
ok("catch has more than the pg-boss default retries", CATCH_RETRY_OPTIONS.retryLimit > 2);

const data = { installationId: 12, repo: "acme/repo", kind: "issue", number: 34 };
const retrying = catchFailureRecord(data, new Error("fetch failed"), false);
ok("temporary failure remains visible as retrying", retrying.state === "retrying");
ok("issue failure uses the stable issue delivery key", retrying.headSha === "" && retrying.mode === "comment");

const failed = catchFailureRecord(data, new Error("fetch failed"), true);
ok("final failure is visible as failed", failed.state === "failed");
ok("failure keeps catch identity", failed.prNumber === 34 && failed.repo === "acme/repo");

const redacted = safeJobError(new Error("Authorization: Bearer token-value api_key=key-value"));
ok("stored error removes bearer credentials", !redacted.includes("token-value"));
ok("stored error removes API keys", !redacted.includes("key-value"));
ok("non-error values remain useful", safeJobError("network unavailable") === "network unavailable");
ok("stored errors are bounded", safeJobError(new Error("x".repeat(500))).length === 300);

console.log(`\n=== queues.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
