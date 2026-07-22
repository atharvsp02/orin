import { expect, test, type Page, type Route } from "@playwright/test"

const allPermissions = [
  "workspace.read",
  "search.use",
  "chat.use",
  "connectors.read",
  "connectors.manage",
  "content.manage",
  "people.manage",
  "policies.manage",
  "settings.manage",
  "audit.read",
]

const driveConnector = {
  connectorId: "10000000-0000-4000-8000-000000000001",
  provider: "gdrive",
  displayName: "Company Drive",
  status: "active",
  capabilities: ["ingest", "query"],
}

const overview = {
  account: "Acme",
  workspace: { workspaceId: "ws-1", displayName: "Acme" },
  connectors: [driveConnector],
  resources: [{
    resourceId: "20000000-0000-4000-8000-000000000001",
    connectorId: driveConnector.connectorId,
    externalId: "drive-1",
    kind: "shared_drive",
    displayName: "Product Drive",
    enabled: true,
  }],
  syncs: [{
    runId: "30000000-0000-4000-8000-000000000001",
    workspaceId: "ws-1",
    connectorId: driveConnector.connectorId,
    status: "succeeded",
    cursorValue: "cursor",
    itemsSeen: 12,
    itemsWritten: 10,
    itemsDeleted: 1,
    errorText: "",
    startedAt: "2026-07-21T08:00:00.000Z",
    finishedAt: "2026-07-21T08:01:00.000Z",
  }],
  metrics: { prsPrevented: 0, decisionsTracked: 0, rejectionsActive: 0 },
  recent: [],
  repos: [],
  links: [],
  installedRepos: [],
}

const searchResult = {
  itemId: "40000000-0000-4000-8000-000000000001",
  connectorId: driveConnector.connectorId,
  resourceId: overview.resources[0].resourceId,
  provider: "gdrive",
  sourceType: "document",
  title: "Payments migration plan",
  snippet: "The rollout uses a staged migration with automatic rollback.",
  url: "https://docs.google.com/document/d/example",
  mimeType: "application/vnd.google-apps.document",
  score: 0.92,
  sourceUpdatedAt: "2026-07-20T08:00:00.000Z",
}

const people = [
  {
    workspaceId: "ws-1",
    userId: "user-1",
    role: "owner",
    status: "active",
    displayName: "Asha Owner",
    primaryEmail: "asha@example.com",
    createdAt: "2026-07-01T08:00:00.000Z",
    updatedAt: "2026-07-01T08:00:00.000Z",
  },
  {
    workspaceId: "ws-1",
    userId: "user-2",
    role: "member",
    status: "active",
    displayName: "Dev Member",
    primaryEmail: "dev@example.com",
    createdAt: "2026-07-02T08:00:00.000Z",
    updatedAt: "2026-07-02T08:00:00.000Z",
  },
]

function me(permissions = allPermissions) {
  return {
    userId: "user-1",
    provider: "github",
    login: "asha",
    displayName: "Asha Owner",
    email: "asha@example.com",
    avatar: "",
    installations: [],
    workspaces: [{
      workspaceId: "ws-1",
      displayName: "Acme",
      decisions: 0,
      role: permissions === allPermissions ? "owner" : "viewer",
      permissions,
      hasGitHubCompatibility: false,
      connectors: [driveConnector],
    }],
  }
}

test("offers every configured dashboard identity provider", async ({ page }) => {
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/v1/me") return json(route, { error: "not signed in" }, 401)
    if (path === "/v1/auth/providers") {
      return json(route, { providers: { github: true, slack: true, linear: true } })
    }
    return json(route, { error: "not found" }, 404)
  })

  await page.goto("/dashboard")

  await expect(page.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute("href", "/v1/auth/github")
  await expect(page.getByRole("link", { name: "Continue with Slack" })).toHaveAttribute("href", "/v1/auth/slack")
  await expect(page.getByRole("link", { name: "Continue with Linear" })).toHaveAttribute("href", "/v1/auth/linear")
})

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

async function mockDashboard(page: Page, permissions = allPermissions) {
  let policies: Array<Record<string, unknown>> = []
  let peopleState = people.map((person) => ({ ...person }))
  let groupsState = [{ groupId: "group-1", workspaceId: "ws-1", displayName: "Engineering", memberCount: 1, memberIds: ["user-2"], createdAt: "2026-07-03T08:00:00.000Z" }]
  let grants: Array<Record<string, unknown>> = []
  await page.route("**/v1/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === "/v1/me") return json(route, me(permissions))
    if (path.endsWith("/overview")) return json(route, overview)
    if (path.endsWith("/decisions")) return json(route, { decisions: [] })
    if (path.endsWith("/search")) return json(route, { results: [searchResult] })
    if (path.endsWith("/chat") && request.method() === "POST") {
      return json(route, { threadId: "thread-1", answer: "Use the staged migration because it has an automatic rollback path.", citations: [searchResult] })
    }
    if (path.endsWith("/chat") && request.method() === "GET") return json(route, { threads: [] })
    if (path.endsWith("/people") && request.method() === "GET") return json(route, { people: peopleState })
    if (path.includes("/people/") && request.method() === "PUT") {
      const userId = path.split("/").at(-1)
      const patch = request.postDataJSON()
      peopleState = peopleState.map((person) => person.userId === userId ? { ...person, ...patch } : person)
      return json(route, peopleState.find((person) => person.userId === userId))
    }
    if (path.endsWith("/groups") && request.method() === "GET") return json(route, { groups: groupsState })
    if (path.includes("/groups/") && request.method() === "PUT") {
      const groupId = path.split("/").at(-1)
      const input = request.postDataJSON()
      groupsState = groupsState.map((group) => group.groupId === groupId ? { ...group, memberIds: input.userIds, memberCount: input.userIds.length } : group)
      return json(route, { groupId, memberIds: input.userIds })
    }
    if (path.endsWith("/policies") && request.method() === "GET") return json(route, { grants })
    if (path.endsWith("/policies") && request.method() === "POST") {
      const input = request.postDataJSON()
      const grant = { ...input, grantId: "grant-1", workspaceId: "ws-1" }
      grants = [grant]
      return json(route, grant, 201)
    }
    if (path.endsWith("/audit")) return json(route, { events: [{ eventId: "event-1", workspaceId: "ws-1", actorUserId: "user-1", action: "connector.sync_completed", targetType: "connector", targetId: driveConnector.connectorId, outcome: "success", details: {}, createdAt: "2026-07-21T08:01:00.000Z" }] })
    if (path.endsWith("/connectorpolicies") && request.method() === "GET") return json(route, { policies })
    if (path.endsWith("/connectorpolicies") && request.method() === "POST") {
      const input = request.postDataJSON()
      const policy = { ...input, policyId: "policy-1", workspaceId: "ws-1", enabled: true }
      policies = [policy]
      return json(route, policy, 201)
    }
    if (path.includes("/connectorpolicies/") && request.method() === "DELETE") {
      policies = []
      return json(route, { deleted: true })
    }
    if (path.includes("/syncs/") && request.method() === "POST") return json(route, { accepted: true, jobId: "job-1" }, 202)
    if ((path.includes("/connectors/") || path.includes("/resources/")) && request.method() === "PUT") return json(route, { enabled: true })
    return json(route, { error: `Unhandled test route ${request.method()} ${path}` }, 500)
  })
}

test("searches authorized sources and answers with a citation", async ({ page }) => {
  await mockDashboard(page)
  await page.goto("/dashboard")

  await page.getByPlaceholder("Search decisions, documents, messages, and issues").fill("migration rollback")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page.getByText("Payments migration plan")).toBeVisible()
  await expect(page.getByText("automatic rollback", { exact: false })).toBeVisible()

  await page.getByText("Ask Orin", { exact: true }).first().click()
  await page.getByPlaceholder("Why did we choose this approach?").fill("Why use a staged migration?")
  await page.getByRole("button", { name: "Ask" }).click()
  await expect(page.getByText("Use the staged migration", { exact: false })).toBeVisible()
  await expect(page.getByText("Payments migration plan")).toBeVisible()
})

test("manages Drive sync health and indexing policies", async ({ page }) => {
  await mockDashboard(page)
  await page.goto("/dashboard")
  await page.getByText("Connectors", { exact: true }).first().click()

  await expect(page.getByRole("heading", { name: "Google Drive" })).toBeVisible()
  await expect(page.getByText("Last sync succeeded", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible()
  await expect(page.getByText("SharePoint", { exact: true })).toBeVisible()
  await expect(page.getByText("Planned", { exact: true }).first()).toBeVisible()

  await page.getByPlaceholder("One value per line or comma separated, for example /Finance/ or application/pdf").fill("/Private/")
  await page.getByRole("button", { name: "Add policy" }).click()
  await expect(page.getByText("/Private/")).toBeVisible()
})

test("shows workspace administration to an owner", async ({ page }) => {
  await mockDashboard(page)
  await page.goto("/dashboard")

  await expect(page.getByText("Administration", { exact: true })).toBeVisible()
  await page.getByText("People", { exact: true }).first().click()
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible()
  await expect(page.getByText("Dev Member")).toBeVisible()
  await page.getByLabel("Role for Dev Member").selectOption("admin")
  await expect(page.getByLabel("Role for Dev Member")).toHaveValue("admin")

  await page.getByText("Groups", { exact: true }).first().click()
  await expect(page.getByText("Engineering")).toBeVisible()
  await page.getByLabel("Dev Member").uncheck()
  await page.getByRole("button", { name: "Save members" }).click()
  await expect(page.getByLabel("Dev Member")).not.toBeChecked()

  await page.getByText("Feature access", { exact: true }).first().click()
  await expect(page.getByRole("heading", { name: "Feature access" })).toBeVisible()
  await page.getByRole("button", { name: "Add grant" }).click()
  await expect(page.getByText("allow chat.use", { exact: true })).toBeVisible()

  await page.getByText("Audit log", { exact: true }).first().click()
  await expect(page.getByText("connector.sync_completed")).toBeVisible()
})

test("clears state and permissions when switching workspaces", async ({ page }) => {
  const identity = me()
  identity.workspaces.push({
    workspaceId: "ws-2",
    displayName: "Beta",
    decisions: 0,
    role: "viewer",
    permissions: ["workspace.read", "search.use", "connectors.read"],
    hasGitHubCompatibility: false,
    connectors: [],
  })
  await page.route("**/v1/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === "/v1/me") return json(route, identity)
    if (path.endsWith("/overview")) {
      const workspaceId = path.includes("ws-2") ? "ws-2" : "ws-1"
      return json(route, { ...overview, account: workspaceId === "ws-2" ? "Beta" : "Acme", workspace: { workspaceId, displayName: workspaceId === "ws-2" ? "Beta" : "Acme" }, connectors: workspaceId === "ws-2" ? [] : overview.connectors, resources: workspaceId === "ws-2" ? [] : overview.resources, syncs: workspaceId === "ws-2" ? [] : overview.syncs })
    }
    if (path.endsWith("/decisions")) return json(route, { decisions: [] })
    if (path.endsWith("/search")) return json(route, { results: [{ ...searchResult, title: path.includes("ws-2") ? "Beta migration plan" : "Acme migration plan" }] })
    return json(route, { error: `Unhandled test route ${request.method()} ${path}` }, 500)
  })

  await page.goto("/dashboard")
  await page.getByPlaceholder("Search decisions, documents, messages, and issues").fill("migration")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page.getByText("Acme migration plan")).toBeVisible()

  await page.getByRole("button", { name: /Acme/ }).first().click()
  await page.getByRole("menuitem", { name: /Beta/ }).click()
  await expect(page.getByText("Acme migration plan")).toHaveCount(0)
  await expect(page.getByPlaceholder("Search decisions, documents, messages, and issues")).toHaveValue("")
  await expect(page.getByText("Administration", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Ask Orin", { exact: true })).toHaveCount(0)
})

test("hides management actions from a viewer", async ({ page }) => {
  await mockDashboard(page, ["workspace.read", "search.use", "connectors.read"])
  await page.goto("/dashboard")

  await expect(page.getByText("Administration", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Ask Orin", { exact: true })).toHaveCount(0)
  await page.getByText("Connectors", { exact: true }).first().click()
  await expect(page.getByRole("heading", { name: "Google Drive" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0)
  await expect(page.getByText("Google Drive content policy", { exact: true })).toHaveCount(0)
})

test("proxies API requests through a bounded allowlisted route", async ({ request }) => {
  const response = await request.post("/v1/proxy-test?mode=e2e", {
    headers: { origin: "http://127.0.0.1:3100" },
    data: { query: "roadmap" },
  })
  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("private, no-store, max-age=0")
  expect(response.headers()["x-ratelimit-remaining"]).toBe("7")
  expect(await response.json()).toMatchObject({
    method: "POST",
    url: "/v1/proxy-test?mode=e2e",
    body: "{\"query\":\"roadmap\"}",
    origin: "http://127.0.0.1:3100",
    forwardedHost: "127.0.0.1:3100",
  })

  const redirect = await request.get("/v1/proxy-redirect", { maxRedirects: 0 })
  expect(redirect.status()).toBe(302)
  expect(redirect.headers().location).toBe("/dashboard?proxied=1")
  const cookies = (await request.storageState()).cookies.filter((cookie) => cookie.name.startsWith("proxy_"))
  expect(cookies.map((cookie) => cookie.name).sort()).toEqual(["proxy_a", "proxy_b"])

  const oversized = await request.post("/v1/proxy-test", { data: "x".repeat(3 * 1024 * 1024 + 1) })
  expect(oversized.status()).toBe(413)
})
