"use client"

// The real Orin dashboard. Deliberately mirrors the hero mockup (dashboard-mockup.tsx): same
// three-pane layout, colors, borders, and type scale. Every value on screen comes from the API;
// empty states are honest and link to real actions. No fabricated data, ever.
import type React from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CirclePower,
  Inbox,
  CircleUser,
  Layers,
  LayoutGrid,
  Users,
  KeyRound,
  Settings as SettingsIcon,
  Search,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Smartphone,
  Map,
  FileText,
  ExternalLink,
  Copy,
  LogOut,
  Slack,
  Network,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { api, timeAgo, type Me, type Overview, type Decision, type KeyRow, type Settings } from "@/lib/orin-api"

type View = "catches" | "decisions" | "repos" | "graph" | "integrations" | "keys" | "settings"

const GITHUB_APP_URL = "https://github.com/apps/orinbot"

export function DashboardShell({ me }: { me: Me }) {
  const [inst, setInst] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = Number(localStorage.getItem("orin.inst"))
      if (me.installations.some((i) => i.installationId === saved)) return saved
    }
    return me.installations[0].installationId
  })
  const [view, setView] = useState<View>("catches")
  const [query, setQuery] = useState("")
  const [overview, setOverview] = useState<Overview | null>(null)
  const [decisions, setDecisions] = useState<Decision[] | null>(null)
  const [selectedCatch, setSelectedCatch] = useState<number>(0)
  const [selectedDecision, setSelectedDecision] = useState<string | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)

  const account = me.installations.find((i) => i.installationId === inst)?.account ?? ""

  const load = useCallback(async () => {
    setOverview(null)
    setDecisions(null)
    const [o, d] = await Promise.all([api.overview(inst), api.decisions(inst)])
    setOverview(o)
    setDecisions(d.decisions)
  }, [inst])

  useEffect(() => {
    localStorage.setItem("orin.inst", String(inst))
    load().catch(() => {})
  }, [inst, load])

  const catchBadge = overview?.recent.filter((r) => r.state === "posted").length ?? 0

  return (
    <div className="h-screen w-full bg-zinc-950 flex overflow-hidden text-sm">
      {/* ── Sidebar (mirrors the hero mockup) ─────────────────────────── */}
      <div className="w-[220px] h-full bg-zinc-900/80 border-r border-zinc-800/50 flex flex-col shrink-0">
        <div className="p-3 border-b border-zinc-800/50">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-zinc-800/50 transition-colors">
                <CirclePower className="w-5 h-5 text-white" />
                <span className="text-white font-semibold text-sm truncate">{account || "Orin"}</span>
                <ChevronDown className="w-3.5 h-3.5 text-zinc-500 ml-auto" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="bg-zinc-900 border-zinc-800 text-zinc-200">
              {me.installations.map((i) => (
                <DropdownMenuItem key={i.installationId} onClick={() => setInst(i.installationId)} className="text-xs">
                  {i.account}
                  <span className="ml-auto text-zinc-500">{i.decisions}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem asChild className="text-xs">
                <a href={GITHUB_APP_URL} target="_blank" rel="noreferrer">
                  Install on another account…
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="p-3">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-zinc-800/50 rounded-md text-zinc-500 text-xs">
            <Search className="w-3.5 h-3.5" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              className="bg-transparent outline-none w-full placeholder:text-zinc-500 text-zinc-300"
            />
          </div>
        </div>

        <div className="px-3 space-y-0.5">
          <NavItem icon={Inbox} label="Catches" badge={catchBadge || undefined} active={view === "catches"} onClick={() => setView("catches")} />
          <NavItem icon={CircleUser} label="Decisions" active={view === "decisions"} onClick={() => setView("decisions")} />
        </div>

        <div className="mt-5 px-3">
          <div className="px-2 py-1 text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Workspace</div>
          <div className="space-y-0.5 mt-1">
            <NavItem icon={Layers} label="Repos" active={view === "repos"} onClick={() => setView("repos")} />
            <NavItem icon={LayoutGrid} label="Knowledge graph" active={view === "graph"} onClick={() => setView("graph")} />
            <NavItem icon={Users} label="Integrations" active={view === "integrations"} onClick={() => setView("integrations")} />
            <NavItem icon={KeyRound} label="Keys" active={view === "keys"} onClick={() => setView("keys")} />
            <NavItem icon={SettingsIcon} label="Settings" active={view === "settings"} onClick={() => setView("settings")} />
          </div>
        </div>

        {overview && overview.repos.length > 0 && (
          <div className="mt-5 px-3">
            <div className="px-2 py-1 text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Repos with memory</div>
            <div className="space-y-0.5 mt-1">
              {overview.repos.slice(0, 3).map((r, i) => (
                <NavItem
                  key={r}
                  icon={[Smartphone, Map, FileText][i] ?? FileText}
                  label={r.split("/")[1] ?? r}
                  color={["text-blue-400", "text-orange-400", "text-emerald-400"][i]}
                  onClick={() => {
                    setSelectedRepo(r)
                    setView("repos")
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {overview && overview.links.length > 0 && (
          <div className="mt-5 px-3">
            <div className="px-2 py-1 text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Linked workspaces</div>
            <div className="space-y-0.5 mt-1">
              {overview.links.map((l) => (
                <NavItem
                  key={`${l.platform}:${l.externalId}`}
                  icon={l.platform === "slack" ? Slack : Network}
                  label={`${l.platform === "slack" ? "Slack" : "Linear"} workspace`}
                  onClick={() => setView("integrations")}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mt-auto p-3 border-t border-zinc-800/50 space-y-0.5">
          <a href={GITHUB_APP_URL} target="_blank" rel="noreferrer" className="block">
            <NavItem icon={HelpCircle} label="Help & Support" />
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300 transition-colors">
                {me.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={me.avatar} alt="" className="w-4 h-4 rounded-full" />
                ) : (
                  <CircleUser className="w-4 h-4" />
                )}
                <span className="flex-1 text-xs text-left truncate">{me.login}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="bg-zinc-900 border-zinc-800 text-zinc-200">
              <DropdownMenuItem asChild className="text-xs">
                <a href={api.logoutUrl}>
                  <LogOut className="w-3.5 h-3.5 mr-1" /> Sign out
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Views ─────────────────────────────────────────────────────── */}
      {view === "catches" && (
        <CatchesView overview={overview} decisions={decisions} query={query} selected={selectedCatch} onSelect={setSelectedCatch} />
      )}
      {view === "decisions" && (
        <DecisionsView decisions={decisions} query={query} repoFilter={null} selected={selectedDecision} onSelect={setSelectedDecision} />
      )}
      {view === "repos" && (
        <ReposView overview={overview} decisions={decisions} selectedRepo={selectedRepo} onSelectRepo={setSelectedRepo} query={query} />
      )}
      {view === "graph" && (
        <FullPanel title="Knowledge graph" subtitle={`Cognee decision graph for ${account}`}>
          <iframe src={api.graphUrl(inst)} sandbox="allow-scripts" className="w-full h-full rounded-lg border border-zinc-800/50 bg-zinc-950" title="Knowledge graph" />
        </FullPanel>
      )}
      {view === "integrations" && <IntegrationsView overview={overview} />}
      {view === "keys" && <KeysView inst={inst} />}
      {view === "settings" && <SettingsView inst={inst} />}
    </div>
  )
}

/* ── shared pieces (classNames copied from the hero mockup) ─────────── */

function NavItem({
  icon: Icon,
  label,
  badge,
  active,
  color,
  onClick,
}: {
  icon: React.ElementType
  label: string
  badge?: number
  active?: boolean
  color?: string
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
        active ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300"
      }`}
    >
      <Icon className={`w-4 h-4 ${color || ""}`} />
      <span className="flex-1 text-xs">{label}</span>
      {badge !== undefined && (
        <span className="bg-indigo-500/80 text-white text-[10px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full font-medium px-1">
          {badge}
        </span>
      )}
    </div>
  )
}

function ListPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="w-[320px] h-full bg-zinc-900/40 border-r border-zinc-800/50 flex flex-col shrink-0">
      <div className="px-4 py-3 border-b border-zinc-800/50 flex items-center justify-between">
        <h3 className="text-white font-semibold text-sm">{title}</h3>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  )
}

function ListItem({
  id,
  title,
  subtitle,
  time,
  status,
  active,
  onClick,
}: {
  id?: string
  title: string
  subtitle?: string
  time?: string
  status: "posted" | "clear" | "ignored" | "rejected" | "accepted" | "reverted" | string
  active?: boolean
  onClick?: () => void
}) {
  const statusColors: Record<string, string> = {
    posted: "bg-red-500",
    clear: "bg-emerald-500",
    ignored: "bg-zinc-600",
    rejected: "bg-red-500",
    accepted: "bg-emerald-500",
    reverted: "bg-yellow-500",
  }
  return (
    <div
      onClick={onClick}
      className={`px-4 py-3 border-b border-zinc-800/30 cursor-pointer transition-colors ${
        active ? "bg-zinc-800/50" : "hover:bg-zinc-800/30"
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        {id && <span className="text-zinc-500 text-[10px]">{id}</span>}
        <div className={`w-2 h-2 rounded-full ${statusColors[status] || "bg-zinc-500"}`} />
        {time && <span className="text-zinc-600 text-[10px] ml-auto">{time}</span>}
      </div>
      <p className="text-white text-xs truncate leading-tight">{title}</p>
      {subtitle && <p className="text-zinc-500 text-[10px] mt-0.5 truncate">{subtitle}</p>}
    </div>
  )
}

function DetailPanel({ crumbs, children }: { crumbs: string[]; children: React.ReactNode }) {
  return (
    <div className="flex-1 h-full bg-zinc-950 flex flex-col overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-800/50 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5 text-xs">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-zinc-600">›</span>}
              <span className={i === crumbs.length - 1 ? "text-zinc-300" : i === 1 ? "text-emerald-400" : "text-zinc-500"}>{c}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="flex-1 p-5 overflow-auto">{children}</div>
    </div>
  )
}

function FullPanel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 h-full bg-zinc-950 flex flex-col overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-800/50 shrink-0">
        <h2 className="text-white text-sm font-semibold">{title}</h2>
        {subtitle && <p className="text-zinc-500 text-xs mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex-1 p-5 overflow-auto">{children}</div>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
    </div>
  )
}

function EmptyState({ title, hint, cta }: { title: string; hint: string; cta?: { label: string; href: string } }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-sm">
        <p className="text-zinc-300 text-sm font-medium mb-1">{title}</p>
        <p className="text-zinc-500 text-xs mb-4">{hint}</p>
        {cta && (
          <a
            href={cta.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-xs"
          >
            {cta.label} <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  )
}

const Loading = () => (
  <div className="flex-1 h-full bg-zinc-950 flex items-center justify-center text-zinc-600 text-xs">Loading…</div>
)

/* ── Catches ────────────────────────────────────────────────────────── */

function CatchesView({
  overview,
  decisions,
  query,
  selected,
  onSelect,
}: {
  overview: Overview | null
  decisions: Decision[] | null
  query: string
  selected: number
  onSelect: (i: number) => void
}) {
  if (!overview) return <Loading />
  const items = overview.recent.filter(
    (r) => !query || `${r.repo} ${r.decisionId ?? ""} ${r.kind}-${r.number}`.toLowerCase().includes(query.toLowerCase()),
  )
  const current = items[selected]
  const decision = current?.decisionId ? decisions?.find((d) => d.decisionId === current.decisionId && d.repo === current.repo) : null

  return (
    <>
      <ListPanel title="Catches">
        {items.length === 0 ? (
          <EmptyState
            title="No catches yet"
            hint="Install Orin on a repo, record a rejection, then open a PR that re-proposes it."
            cta={{ label: "Install on GitHub", href: GITHUB_APP_URL }}
          />
        ) : (
          items.map((r, i) => (
            <ListItem
              key={`${r.repo}#${r.number}@${r.updatedAt}`}
              id={`${r.kind.toUpperCase()}-${r.number}`}
              title={r.decisionId ? `Re-proposes ${r.decisionId}` : "Checked: no conflict"}
              subtitle={r.repo}
              time={timeAgo(r.updatedAt)}
              status={r.state}
              active={i === selected}
              onClick={() => onSelect(i)}
            />
          ))
        )}
      </ListPanel>

      <div className="flex-1 h-full bg-zinc-950 flex flex-col overflow-hidden">
        <div className="grid grid-cols-3 gap-3 p-5 border-b border-zinc-800/50">
          <StatTile label="Decisions tracked" value={overview.metrics.decisionsTracked} />
          <StatTile label="Active rejections" value={overview.metrics.rejectionsActive} />
          <StatTile label="PRs prevented" value={overview.metrics.prsPrevented} />
        </div>
        <div className="flex-1 overflow-auto">
          {!current ? (
            <EmptyState title="Nothing selected" hint="Catches appear here as Orin checks PRs and issues." />
          ) : (
            <div className="p-5">
              <div className="flex items-center gap-1.5 text-xs mb-4">
                <span className="text-zinc-500">{current.repo}</span>
                <span className="text-zinc-600">›</span>
                <span className="text-emerald-400">Decision memory</span>
                <span className="text-zinc-600">›</span>
                <span className="text-zinc-300">
                  {current.kind.toUpperCase()}-{current.number}
                </span>
              </div>
              <h2 className="text-white text-xl font-semibold mb-5">
                {current.decisionId ? `Re-proposes ${current.decisionId}` : "No decision conflict"}
              </h2>
              {decision && (
                <div className="bg-zinc-900/80 rounded-lg p-4 text-[12px] font-mono mb-5 border border-zinc-800/50 space-y-2">
                  <div>
                    <span className="text-zinc-500">Orin.</span>
                    <span className="text-amber-300">check_rejected</span>
                    <span className="text-zinc-400"> flagged this {current.kind} as a </span>
                    <span className="text-cyan-300">re-proposal</span>
                  </div>
                  <div>
                    <span className="text-purple-400">@decision</span>
                    <span className="text-zinc-400">(</span>
                    <span className="text-cyan-300">{decision.decisionId}</span>
                    <span className="text-zinc-400">, outcome: </span>
                    <span className="text-orange-300">{decision.outcome}</span>
                    <span className="text-zinc-400">, superseded: </span>
                    <span className="text-orange-300">{decision.supersededBy ? decision.supersededBy : "false"}</span>
                    <span className="text-zinc-400">)</span>
                  </div>
                  <div className="text-zinc-400 pt-1">{decision.reasoning}</div>
                </div>
              )}
              <div className="flex items-center gap-3 text-xs">
                <a
                  href={`https://github.com/${current.repo}/${current.kind === "pr" ? "pull" : "issues"}/${current.number}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Open {current.kind.toUpperCase()}-{current.number} on GitHub
                </a>
                {decision?.sourceUrl && (
                  <a
                    href={decision.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> View cited decision
                  </a>
                )}
                <span className="ml-auto text-zinc-600">state: {current.state}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/* ── Decisions ──────────────────────────────────────────────────────── */

function DecisionsView({
  decisions,
  query,
  repoFilter,
  selected,
  onSelect,
}: {
  decisions: Decision[] | null
  query: string
  repoFilter: string | null
  selected: string | null
  onSelect: (id: string) => void
}) {
  if (!decisions) return <Loading />
  const items = decisions.filter(
    (d) =>
      (!repoFilter || d.repo === repoFilter) &&
      (!query || `${d.decisionId} ${d.title} ${d.repo}`.toLowerCase().includes(query.toLowerCase())),
  )
  const current = items.find((d) => d.decisionId === selected) ?? items[0]

  return (
    <>
      <ListPanel title={repoFilter ? `Decisions · ${repoFilter}` : "Decisions"}>
        {items.length === 0 ? (
          <EmptyState
            title="No decisions recorded"
            hint="Orin extracts decisions from closed PRs and issues after you install it on a repo."
            cta={{ label: "Install on GitHub", href: GITHUB_APP_URL }}
          />
        ) : (
          items.map((d) => (
            <ListItem
              key={`${d.repo}:${d.decisionId}`}
              id={d.decisionId}
              title={d.title}
              subtitle={`${d.repo || "(workspace)"}${d.supersededBy ? ` · superseded by ${d.supersededBy}` : ""}`}
              status={d.outcome}
              active={current?.decisionId === d.decisionId}
              onClick={() => onSelect(d.decisionId)}
            />
          ))
        )}
      </ListPanel>
      {!current ? (
        <div className="flex-1 bg-zinc-950" />
      ) : (
        <DetailPanel crumbs={[current.repo || "workspace", "Decision memory", current.decisionId]}>
          <h2 className="text-white text-xl font-semibold mb-2">{current.title}</h2>
          <div className="flex items-center gap-2 mb-5">
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wide ${
                current.outcome === "rejected" ? "bg-red-500/15 text-red-400" : current.outcome === "accepted" ? "bg-emerald-500/15 text-emerald-400" : "bg-yellow-500/15 text-yellow-400"
              }`}
            >
              {current.outcome}
            </span>
            {current.supersededBy && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">superseded by {current.supersededBy}</span>
            )}
            {current.decidedAt && <span className="text-zinc-600 text-xs">decided {new Date(current.decidedAt).toLocaleDateString()}</span>}
          </div>
          <div className="bg-zinc-900/80 rounded-lg p-4 text-xs border border-zinc-800/50 text-zinc-300 leading-relaxed mb-5">
            {current.reasoning || "No reasoning text recorded."}
          </div>
          {current.sourceUrl && (
            <a
              href={current.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Source thread
            </a>
          )}
        </DetailPanel>
      )}
    </>
  )
}

/* ── Repos ──────────────────────────────────────────────────────────── */

function ReposView({
  overview,
  decisions,
  selectedRepo,
  onSelectRepo,
  query,
}: {
  overview: Overview | null
  decisions: Decision[] | null
  selectedRepo: string | null
  onSelectRepo: (r: string) => void
  query: string
}) {
  const [selDecision, setSelDecision] = useState<string | null>(null)
  if (!overview || !decisions) return <Loading />
  const repos = overview.repos
  const current = selectedRepo && repos.includes(selectedRepo) ? selectedRepo : repos[0]

  if (repos.length === 0)
    return (
      <div className="flex-1 bg-zinc-950">
        <EmptyState
          title="No repos with memory yet"
          hint="Install Orin on a repository; its closed PRs and issues become decision memory."
          cta={{ label: "Install on GitHub", href: GITHUB_APP_URL }}
        />
      </div>
    )

  return (
    <>
      <ListPanel title="Repos">
        {repos.map((r) => (
          <ListItem
            key={r}
            title={r}
            subtitle={`${decisions.filter((d) => d.repo === r).length} decisions`}
            status={r === current ? "posted" : "ignored"}
            active={r === current}
            onClick={() => onSelectRepo(r)}
          />
        ))}
      </ListPanel>
      <DecisionsView decisions={decisions} query={query} repoFilter={current ?? null} selected={selDecision} onSelect={setSelDecision} />
    </>
  )
}

/* ── Integrations ───────────────────────────────────────────────────── */

function IntegrationsView({ overview }: { overview: Overview | null }) {
  if (!overview) return <Loading />
  const has = (p: string) => overview.links.some((l) => l.platform === p)
  const rows = [
    { name: "GitHub App", desc: "Required check + @orin commands on PRs and issues", linked: true, href: GITHUB_APP_URL, action: "Manage" },
    { name: "Slack app", desc: "/why in channels, 🧠 reactions record decisions", linked: has("slack"), href: "https://orin-bot.duckdns.org/slack/install", action: has("slack") ? "Linked" : "Install" },
    { name: "Linear agent", desc: "Agent sessions in issues + collision warnings", linked: has("linear"), href: "https://orin-bot.duckdns.org/linear/install", action: has("linear") ? "Linked" : "Install" },
  ]
  return (
    <FullPanel title="Integrations" subtitle="One memory, every surface. Each workspace is an isolated tenant.">
      <div className="space-y-3 max-w-2xl">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div>
              <div className="text-white text-sm font-medium flex items-center gap-2">
                {r.name}
                {r.linked && <span className="w-2 h-2 rounded-full bg-emerald-500" />}
              </div>
              <div className="text-zinc-500 text-xs mt-0.5">{r.desc}</div>
            </div>
            <a
              href={r.href}
              target="_blank"
              rel="noreferrer"
              className="text-xs px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              {r.action}
            </a>
          </div>
        ))}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="text-white text-sm font-medium mb-1">MCP (Cursor, Claude Code, CLI)</div>
          <div className="text-zinc-500 text-xs mb-3">Mint a repo-scoped key under Keys, then add:</div>
          <pre className="bg-zinc-950 rounded-lg p-3 text-[11px] font-mono text-zinc-400 overflow-x-auto border border-zinc-800/50">
{`{ "mcpServers": { "orin": {
    "url": "https://orin-bot.duckdns.org/mcp",
    "headers": { "Authorization": "Bearer <your orin_ key>" } } } }`}
          </pre>
        </div>
        <p className="text-zinc-600 text-xs">
          Cross-platform linking: in Slack run <span className="text-zinc-400 font-mono">/orin link</span>, then comment{" "}
          <span className="text-zinc-400 font-mono">@orin link CODE</span> on any issue in this org.
        </p>
      </div>
    </FullPanel>
  )
}

/* ── Keys ───────────────────────────────────────────────────────────── */

function KeysView({ inst }: { inst: number }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null)
  const [repo, setRepo] = useState("")
  const [label, setLabel] = useState("")
  const [minted, setMinted] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => api.keys(inst).then((r) => setKeys(r.keys)).catch(() => setKeys([])), [inst])
  useEffect(() => {
    refresh()
  }, [refresh])

  const mint = async () => {
    setError(null)
    try {
      const r = await api.mintKey(inst, repo.trim(), label.trim())
      setMinted(r.key)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <FullPanel title="Keys" subtitle="Repo-scoped orin_ keys for CI pre-flight, the GitHub Action, and MCP clients.">
      <div className="max-w-3xl">
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o) {
              setMinted(null)
              setRepo("")
              setLabel("")
              setError(null)
            }
          }}
        >
          <DialogTrigger asChild>
            <button className="mb-4 px-4 py-2 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-xs">
              Mint new key
            </button>
          </DialogTrigger>
          <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-200">
            <DialogHeader>
              <DialogTitle className="text-sm">Mint a repo-scoped key</DialogTitle>
            </DialogHeader>
            {minted ? (
              <div>
                <p className="text-xs text-zinc-400 mb-2">Copy it now; it is shown only once and stored hashed.</p>
                <div className="flex items-center gap-2 bg-zinc-950 rounded-lg p-3 border border-zinc-800">
                  <code className="text-[11px] text-emerald-400 break-all flex-1">{minted}</code>
                  <button onClick={() => navigator.clipboard.writeText(minted)} className="text-zinc-400 hover:text-white shrink-0">
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Input
                  placeholder="repo (owner/name)"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs"
                />
                <Input
                  placeholder="label (e.g. ci-gate)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs"
                />
                {error && <p className="text-red-400 text-xs">{error}</p>}
                <button
                  onClick={mint}
                  disabled={!repo.trim()}
                  className="px-4 py-2 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-xs disabled:opacity-40"
                >
                  Mint
                </button>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {!keys ? (
          <p className="text-zinc-600 text-xs">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-zinc-500 text-xs">No keys yet. Mint one to use the CLI, GitHub Action, or MCP.</p>
        ) : (
          <div className="rounded-xl border border-zinc-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900/80 text-zinc-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Label</th>
                  <th className="text-left px-4 py-2 font-medium">Repo</th>
                  <th className="text-left px-4 py-2 font-medium">Created</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.keyHash} className="border-t border-zinc-800/50 text-zinc-300">
                    <td className="px-4 py-2">{k.label || <span className="text-zinc-600">(no label)</span>}</td>
                    <td className="px-4 py-2 font-mono text-[11px]">{k.repo}</td>
                    <td className="px-4 py-2 text-zinc-500">{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-2">
                      {k.revokedAt ? <span className="text-zinc-600">revoked</span> : <span className="text-emerald-400">active</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {!k.revokedAt && (
                        <button
                          onClick={() => api.revokeKey(inst, k.keyHash).then(refresh)}
                          className="text-red-400/80 hover:text-red-300 text-[11px]"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </FullPanel>
  )
}

/* ── Settings ───────────────────────────────────────────────────────── */

function SettingsView({ inst }: { inst: number }) {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.settings(inst).then(setS).catch(() => {})
  }, [inst])

  if (!s) return <Loading />

  const save = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const next = await api.saveSettings(inst, s)
      setS(next)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-6 py-3 border-b border-zinc-800/50">
      <div>
        <div className="text-zinc-200 text-xs font-medium">{label}</div>
        {hint && <div className="text-zinc-600 text-[11px] mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )

  return (
    <FullPanel title="Settings" subtitle="How Orin delivers and judges catches for this installation.">
      <div className="max-w-2xl">
        <Row label="Delivery mode" hint="check = merge-blocking status check, review = inline PR review, comment = plain comment">
          <Select value={s.deliveryMode} onValueChange={(v) => setS({ ...s, deliveryMode: v })}>
            <SelectTrigger className="w-36 bg-zinc-950 border-zinc-800 text-zinc-200 text-xs h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-200">
              <SelectItem value="check">check</SelectItem>
              <SelectItem value="review">review</SelectItem>
              <SelectItem value="comment">comment</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="Block on re-proposal" hint="Fail the required check when a PR re-proposes a rejected decision">
          <Switch checked={s.blockOnRepropose} onCheckedChange={(v) => setS({ ...s, blockOnRepropose: v })} />
        </Row>
        <Row label="Auto-comment" hint="Let Orin write on PRs/issues (off = silent, log-only)">
          <Switch checked={s.autoComment} onCheckedChange={(v) => setS({ ...s, autoComment: v })} />
        </Row>
        <Row label="LLM provider" hint="Model used for extraction and judgment">
          <Select value={s.llmProvider} onValueChange={(v) => setS({ ...s, llmProvider: v })}>
            <SelectTrigger className="w-36 bg-zinc-950 border-zinc-800 text-zinc-200 text-xs h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-200">
              <SelectItem value="deepseek">deepseek</SelectItem>
              <SelectItem value="google">google</SelectItem>
              <SelectItem value="openai">openai</SelectItem>
              <SelectItem value="openrouter">openrouter</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="Grounding threshold" hint="Minimum shared terms before a decision is even considered (precision gate)">
          <Input
            type="number"
            min={1}
            max={10}
            value={s.confidenceThreshold}
            onChange={(e) => setS({ ...s, confidenceThreshold: Number(e.target.value) })}
            className="w-20 bg-zinc-950 border-zinc-800 text-zinc-200 text-xs h-8"
          />
        </Row>
        <Row label="Semantic cutoff" hint="Max cosine distance for the semantic pass (lower = stricter)">
          <Input
            type="number"
            step={0.05}
            min={0.1}
            max={2}
            value={s.scoreCutoff}
            onChange={(e) => setS({ ...s, scoreCutoff: Number(e.target.value) })}
            className="w-20 bg-zinc-950 border-zinc-800 text-zinc-200 text-xs h-8"
          />
        </Row>
        <div className="py-3 border-b border-zinc-800/50">
          <div className="text-zinc-200 text-xs font-medium mb-2">Custom instructions</div>
          <Textarea
            value={s.customInstructions}
            onChange={(e) => setS({ ...s, customInstructions: e.target.value })}
            placeholder="Extra guidance for Orin's judgment, e.g. what counts as a decision in this org."
            className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs min-h-20"
          />
        </div>
        <div className="pt-4 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-xs disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {saved && <span className="text-emerald-400 text-xs">Saved.</span>}
        </div>
      </div>
    </FullPanel>
  )
}
