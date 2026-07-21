const {
  connectorSupports,
  normalizeCapabilities,
  normalizeConnectorRef,
} = await import("../dist/connectors.js");

let pass = 0;
let fail = 0;

const ok = (name, condition) => {
  if (condition) pass++;
  else fail++;
  console.log(`  ${condition ? "PASS" : "FAIL"} ${name}`);
};

const throws = (name, fn, message) => {
  try {
    fn();
    ok(name, false);
  } catch (error) {
    ok(name, error instanceof Error && error.message === message);
  }
};

const ref = normalizeConnectorRef({ provider: " GitHub ", externalId: " 12345 " });
ok("connector ref normalizes provider and external id", ref.provider === "github" && ref.externalId === "12345");
ok(
  "connector ref preserves case-sensitive external ids",
  normalizeConnectorRef({ provider: "slack", externalId: " T-AbC " }).externalId === "T-AbC",
);
ok(
  "provider slug accepts the 64 character boundary",
  normalizeConnectorRef({ provider: `a${"b".repeat(63)}`, externalId: "1" }).provider.length === 64,
);
throws("connector ref rejects empty provider", () => normalizeConnectorRef({ provider: " ", externalId: "1" }), "connector provider is required");
throws("connector ref rejects empty external id", () => normalizeConnectorRef({ provider: "slack", externalId: " " }), "connector external id is required");
throws("connector ref rejects invalid provider slug", () => normalizeConnectorRef({ provider: "git/hub", externalId: "1" }), "connector provider is invalid");
throws("provider slug rejects values over 64 characters", () => normalizeConnectorRef({ provider: `a${"b".repeat(64)}`, externalId: "1" }), "connector provider is invalid");

const capabilities = normalizeCapabilities(["warn", "query", "warn", "ingest"]);
ok("capabilities are unique and consistently ordered", JSON.stringify(capabilities) === JSON.stringify(["ingest", "query", "warn"]));
ok("empty capabilities remain empty", normalizeCapabilities([]).length === 0);
throws("unknown capability is rejected", () => normalizeCapabilities(["admin"]), "unsupported connector capability: admin");

const connector = {
  connectorId: "connector-1",
  workspaceId: "workspace-1",
  provider: "github",
  externalId: "12345",
  displayName: "Acme GitHub",
  status: "active",
  capabilities: ["ingest", "query"],
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
};
ok("active connector exposes configured capability", connectorSupports(connector, "query") === true);
ok("active connector rejects missing capability", connectorSupports(connector, "deliver") === false);
ok("disabled connector exposes no capabilities", connectorSupports({ ...connector, status: "disabled" }, "query") === false);

console.log(`\n=== connectors.ts: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
