import assert from "node:assert/strict";

const { contentAllowed, policyMatches, searchSnippet } = await import("../dist/content.js");

const target = {
  provider: "gdrive",
  resourceId: "shared-drive-1",
  owner: "owner@example.com",
  mimeType: "application/vnd.google-apps.document",
  path: "/Engineering/Architecture/Cache",
  sourceType: "document",
};

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

console.log("content policy");

test("matches normalized equality", () => {
  assert.equal(policyMatches({ effect: "include", field: "provider", operator: "equals", values: ["GDrive"], enabled: true }, target), true);
});

test("matches contains and prefix operators", () => {
  assert.equal(policyMatches({ effect: "include", field: "path", operator: "contains", values: ["architecture"], enabled: true }, target), true);
  assert.equal(policyMatches({ effect: "include", field: "path", operator: "starts_with", values: ["/engineering"], enabled: true }, target), true);
});

test("disabled and empty policies never match", () => {
  assert.equal(policyMatches({ effect: "exclude", field: "owner", operator: "equals", values: ["owner@example.com"], enabled: false }, target), false);
  assert.equal(policyMatches({ effect: "exclude", field: "owner", operator: "equals", values: [], enabled: true }, target), false);
});

test("allows content when no include policy exists", () => {
  assert.equal(contentAllowed([], target), true);
});

test("requires a match when include policies exist", () => {
  assert.equal(contentAllowed([
    { effect: "include", field: "resourceId", operator: "one_of", values: ["shared-drive-2"], enabled: true },
  ], target), false);
});

test("exclusion wins over inclusion", () => {
  assert.equal(contentAllowed([
    { effect: "include", field: "resourceId", operator: "equals", values: ["shared-drive-1"], enabled: true },
    { effect: "exclude", field: "path", operator: "contains", values: ["cache"], enabled: true },
  ], target), false);
});

test("builds bounded plain text snippets around a match", () => {
  const body = `Start ${"background ".repeat(30)}permission boundary ${"ending ".repeat(30)}`;
  const snippet = searchSnippet(body, "permission", 100);
  assert.ok(snippet.includes("permission"));
  assert.ok(snippet.length <= 102);
  assert.ok(snippet.startsWith("…"));
});

test("returns short and empty content unchanged", () => {
  assert.equal(searchSnippet(" short   text ", "text"), "short text");
  assert.equal(searchSnippet("", "text"), "");
});

console.log(`${passed} content policy checks passed`);

