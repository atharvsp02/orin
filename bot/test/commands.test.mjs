// Unit test for the pure @codeguard command parser.
// Env is set before importing (config/crypto validate required vars at module load).
process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.CODEGUARD_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const { parseCommand } = await import("../dist/commands.js");

let pass = 0,
  fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

eq("recall", parseCommand("@codeguard recall Prisma ORM"), { name: "recall", query: "Prisma ORM" });
eq("why (ignores trailing text)", parseCommand("hey @codeguard why did we do this?"), { name: "why" });
eq("override ref + quoted", parseCommand('@codeguard override PR-42 "we changed our mind"'), {
  name: "override",
  ref: "PR-42",
  reason: "we changed our mind",
});
eq("override quoted only", parseCommand('@codeguard override "just because"'), {
  name: "override",
  ref: undefined,
  reason: "just because",
});
eq("override ref + unquoted", parseCommand("@codeguard override PR-9 reason without quotes"), {
  name: "override",
  ref: "PR-9",
  reason: "reason without quotes",
});
eq("ignore", parseCommand("@codeguard ignore"), { name: "ignore" });
eq("re-scan (hyphen)", parseCommand("@codeguard re-scan"), { name: "rescan" });
eq("rescan", parseCommand("@codeguard rescan"), { name: "rescan" });
eq("no command", parseCommand("just a normal comment"), null);
eq("case-insensitive", parseCommand("@CodeGuard WHY"), { name: "why" });

console.log(`\n=== commands.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
