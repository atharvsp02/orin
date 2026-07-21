// Unit test for the pure @orin command parser.
// Env is set before importing (config/crypto validate required vars at module load).
process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:5432/x";
process.env.ORIN_SECRET ??= "test-secret-please-rotate-0000000000000000";
process.env.GITHUB_APP_ID ??= "1";
process.env.GITHUB_PRIVATE_KEY ??= "dummy";
process.env.GITHUB_WEBHOOK_SECRET ??= "dummy";

const { githubInstallationLinkEligible, parseCommand } = await import("../dist/commands.js");

let pass = 0,
  fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

eq("recall", parseCommand("@orin recall Prisma ORM"), { name: "recall", query: "Prisma ORM" });
eq("why (ignores trailing text)", parseCommand("hey @orin why did we do this?"), { name: "why" });
eq("override ref + quoted", parseCommand('@orin override PR-42 "we changed our mind"'), {
  name: "override",
  ref: "PR-42",
  reason: "we changed our mind",
});
eq("override quoted only", parseCommand('@orin override "just because"'), {
  name: "override",
  ref: undefined,
  reason: "just because",
});
eq("override ref + unquoted", parseCommand("@orin override PR-9 reason without quotes"), {
  name: "override",
  ref: "PR-9",
  reason: "reason without quotes",
});
eq("ignore", parseCommand("@orin ignore"), { name: "ignore" });
eq("re-scan (hyphen)", parseCommand("@orin re-scan"), { name: "rescan" });
eq("rescan", parseCommand("@orin rescan"), { name: "rescan" });
eq("no command", parseCommand("just a normal comment"), null);
eq("case-insensitive", parseCommand("@Orin WHY"), { name: "why" });
eq("good", parseCommand("@orin good — nice catch"), { name: "good" });
eq("bad", parseCommand("@orin bad, false positive"), { name: "bad" });
eq("thumbs up emoji", parseCommand("@orin 👍"), { name: "good" });
eq("thumbs down emoji", parseCommand("@orin 👎"), { name: "bad" });
eq("forget", parseCommand("@orin forget"), { name: "forget" });
eq("rules (list)", parseCommand("@orin rules"), { name: "rules" });
eq("rule (seed)", parseCommand("@orin rule Do not add new deps"), { name: "rule", text: "Do not add new deps" });
eq("link with code", parseCommand("@orin link AB12CD34"), { name: "link", code: "AB12CD34" });
eq("link without code", parseCommand("@orin link"), { name: "link", code: "" });
eq("orinbot mention (autocomplete form)", parseCommand("@orinbot why did we do this"), { name: "why" });
eq("OrinBot case-insensitive", parseCommand("@OrinBot good catch"), { name: "good" });
eq("orinbot override with ref", parseCommand('@orinbot override PR-42 "changed our mind"'), { name: "override", ref: "PR-42", reason: "changed our mind" });
eq("no partial-word match (overrides)", parseCommand("@orin overrides everything"), null);
eq("personal installation owner can approve a link", githubInstallationLinkEligible("atharv", "Atharv"), true);
eq("active organization owner can approve a link", githubInstallationLinkEligible("acme", "maintainer", { state: "active", role: "admin" }), true);
eq("organization member cannot approve a link", githubInstallationLinkEligible("acme", "maintainer", { state: "active", role: "member" }), false);
eq("pending organization owner cannot approve a link", githubInstallationLinkEligible("acme", "maintainer", { state: "pending", role: "admin" }), false);

console.log(`\n=== commands.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
