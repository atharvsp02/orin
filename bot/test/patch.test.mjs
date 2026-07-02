// Unit test for the pure diff-anchoring logic (no GitHub / engine / db).
// Run: npm test  (builds first, then executes against dist/).
import { parsePatch, anchorFor, suggestionBlock } from "../dist/patch.js";

let pass = 0,
  fail = 0;
const ok = (name, cond) => {
  if (cond) {
    pass++;
    console.log("  PASS", name);
  } else {
    fail++;
    console.log("  FAIL", name);
  }
};

// parsePatch: head/base line tracking
const patch1 = ["@@ -10,2 +10,3 @@", " unchanged", "+added prisma orm here", " another"].join("\n");
const lines = parsePatch("a.ts", patch1);
const added = lines.filter((l) => l.add);
ok("parse: one added line", added.length === 1);
ok("parse: added headLine = 11", added[0].headLine === 11);
ok("parse: context after add tracks head=12", lines.find((l) => l.content === "another")?.headLine === 12);

// anchorFor: picks the line overlapping decision terms
const files = [
  {
    path: "src/db.ts",
    status: "modified",
    additions: 2,
    deletions: 0,
    patch: ["@@ -1,1 +1,3 @@", " import x", "+const client = new PrismaClient();", "+// prisma orm setup"].join("\n"),
  },
];
const a1 = anchorFor(files, ["prisma", "orm"], { level: "failure", message: "re-proposes DR-1" });
ok("anchor: found", a1 !== null);
ok("anchor: right path", a1?.path === "src/db.ts");
ok("anchor: on an added line", a1?.line === 2 || a1?.line === 3);
ok("anchor: level passthrough", a1?.level === "failure");

// contiguous multi-line added run
const files2 = [
  {
    path: "f.ts",
    status: "added",
    additions: 3,
    deletions: 0,
    patch: ["@@ -0,0 +1,3 @@", "+prisma line one", "+prisma line two", "+unrelated"].join("\n"),
  },
];
const a2 = anchorFor(files2, ["prisma"], { level: "warning", message: "m" });
ok("multiline: run spans contiguous added block (1..3)", a2?.startLine === 1 && a2?.line === 3);

// no overlap → null
ok("no overlap → null", anchorFor(files, ["mongodb", "mongoose"], { level: "failure", message: "m" }) === null);

// suggestion fence widening
ok("suggestion: normal fence", suggestionBlock("const x = 1;").startsWith("```suggestion"));
ok("suggestion: widened fence when backticks present", suggestionBlock("a ```b``` c").startsWith("````suggestion"));

console.log(`\n=== patch.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
