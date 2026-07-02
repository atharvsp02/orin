// Unit tests for the pure decision-core helpers (grounding gate, recency decay, temporal routing).
process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.CODEGUARD_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const { grounded, recencyWeight, isTemporalQuery } = await import("../dist/pipeline.js");

let pass = 0,
  fail = 0;
const ok = (name, cond) => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}`);
};

// grounding gate
ok("grounded: enough overlap", grounded("we should add redis caching", "redis caching layer", 2));
ok("grounded: below threshold", !grounded("add redis", "postgres tuning", 2));

// recency decay — bounded in [FLOOR, 1], monotonically decreasing with age, floors out.
const now = Date.parse("2026-07-02T00:00:00Z");
const wNow = recencyWeight("2026-07-01T00:00:00Z", now);
const wOld = recencyWeight("2024-01-01T00:00:00Z", now);
const wAncient = recencyWeight("2000-01-01T00:00:00Z", now);
ok("recency: fresh ~ 1", wNow > 0.99 && wNow <= 1);
ok("recency: older is lower", wOld < wNow);
ok("recency: never below floor 0.85", wAncient >= 0.85);
ok("recency: bad date → 1", recencyWeight("not-a-date", now) === 1);

// temporal routing heuristic
ok("temporal: quarter", isTemporalQuery("what did we reject in Q1?"));
ok("temporal: year", isTemporalQuery("decisions from 2025"));
ok("temporal: plain question is not temporal", !isTemporalQuery("why did we drop redis"));

console.log(`\n=== pipeline.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
