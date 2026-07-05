"use client"

// The real Orin dashboard. Same three-pane layout as the hero mockup, and the inner views share
// the landing page's design language: centered content columns, bordered cards with a soft top
// sheen, syntax-colored code, brand icons. Every value comes from the API; empty states are
// honest and specific. No fabricated data, ever.
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  HelpCircle,
  ExternalLink,
  Copy,
  Check,
  LogOut,
  Slack as SlackIcon,
  Network,
  GitBranch,
  FileText,
  BookOpen,
  Upload,
  Plus,
} from "lucide-react"
import { SiGithub, SiLinear } from "@icons-pack/react-simple-icons"
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
import { api, timeAgo, type Me, type Overview, type Decision, type KeyRow, type Settings, type GraphData } from "@/lib/orin-api"

type View = "catches" | "decisions" | "repos" | "rules" | "docs" | "graph" | "integrations" | "keys" | "settings"

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
      <div className="w-[13.75rem] h-full bg-zinc-900/80 border-r border-zinc-800/50 flex flex-col shrink-0">
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
              <DropdownMenuItem asChild className="text-xs">
                {/* sessions snapshot the installation list; a silent OAuth round-trip refreshes it */}
                <a href="/v1/auth/github">Refresh installations</a>
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
          <div className="px-2 py-1 text-[0.625rem] text-zinc-500 font-medium uppercase tracking-wider">Workspace</div>
          <div className="space-y-0.5 mt-1">
            <NavItem icon={Layers} label="Repos" active={view === "repos"} onClick={() => setView("repos")} />
            <NavItem icon={BookOpen} label="Rules" active={view === "rules"} onClick={() => setView("rules")} />
            <NavItem icon={Upload} label="Docs" active={view === "docs"} onClick={() => setView("docs")} />
            <NavItem icon={LayoutGrid} label="Knowledge graph" active={view === "graph"} onClick={() => setView("graph")} />
            <NavItem icon={Users} label="Integrations" active={view === "integrations"} onClick={() => setView("integrations")} />
            <NavItem icon={KeyRound} label="Keys" active={view === "keys"} onClick={() => setView("keys")} />
            <NavItem icon={SettingsIcon} label="Settings" active={view === "settings"} onClick={() => setView("settings")} />
          </div>
        </div>

        {overview && overview.installedRepos.length > 0 && (
          <div className="mt-5 px-3">
            <div className="px-2 py-1 text-[0.625rem] text-zinc-500 font-medium uppercase tracking-wider">Connected repos</div>
            <div className="space-y-0.5 mt-1">
              {overview.installedRepos.slice(0, 4).map((r, i) => (
                <NavItem
                  key={r}
                  icon={GitBranch}
                  label={r.split("/")[1] ?? r}
                  color={["text-blue-400", "text-orange-400", "text-emerald-400", "text-purple-400"][i]}
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
            <div className="px-2 py-1 text-[0.625rem] text-zinc-500 font-medium uppercase tracking-wider">Linked workspaces</div>
            <div className="space-y-0.5 mt-1">
              {overview.links.map((l) => (
                <NavItem
                  key={`${l.platform}:${l.externalId}`}
                  icon={l.platform === "slack" ? SlackIcon : Network}
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
      {view === "rules" && <RulesView inst={inst} overview={overview} />}
      {view === "docs" && <DocsView inst={inst} overview={overview} />}
      {view === "graph" && <GraphView inst={inst} account={account} />}
      {view === "integrations" && <IntegrationsView inst={inst} overview={overview} />}
      {view === "keys" && <KeysView inst={inst} overview={overview} />}
      {view === "settings" && <SettingsView inst={inst} />}
    </div>
  )
}

/* ── shared pieces ──────────────────────────────────────────────────── */

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
        <span className="bg-indigo-500/80 text-white text-[0.625rem] min-w-[1.125rem] h-[1.125rem] flex items-center justify-center rounded-full font-medium px-1">
          {badge}
        </span>
      )}
    </div>
  )
}

function ListPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="w-[20rem] h-full bg-zinc-900/40 border-r border-zinc-800/50 flex flex-col shrink-0">
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
  status: string
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
    repo: "bg-blue-400",
  }
  return (
    <div
      onClick={onClick}
      className={`px-4 py-3 border-b border-zinc-800/30 cursor-pointer transition-colors ${
        active ? "bg-zinc-800/50" : "hover:bg-zinc-800/30"
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        {id && <span className="text-zinc-500 text-[0.625rem]">{id}</span>}
        <div className={`w-2 h-2 rounded-full ${statusColors[status] || "bg-zinc-500"}`} />
        {time && <span className="text-zinc-600 text-[0.625rem] ml-auto">{time}</span>}
      </div>
      <p className="text-white text-xs truncate leading-tight">{title}</p>
      {subtitle && <p className="text-zinc-500 text-[0.625rem] mt-0.5 truncate">{subtitle}</p>}
    </div>
  )
}

/** Full-width view: centered content column, landing-style header, contextual guide rail. */
function FullPanel({
  title,
  subtitle,
  action,
  rail,
  children,
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
  rail?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex-1 h-full bg-zinc-950 flex overflow-hidden relative">
      <div
        className="absolute top-0 left-0 right-0 pointer-events-none"
        style={{ height: "120px", background: "linear-gradient(to bottom, rgba(255,255,255,0.03), transparent)" }}
      />
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto w-full px-8 py-10">
          <div className="flex items-start justify-between gap-6 mb-8">
            <div>
              <h2 className="text-white text-xl font-medium tracking-tight">{title}</h2>
              {subtitle && <p className="text-zinc-500 text-xs mt-1.5 max-w-lg leading-relaxed">{subtitle}</p>}
            </div>
            {action}
          </div>
          {children}
        </div>
      </div>
      {rail && <HelpRail>{rail}</HelpRail>}
    </div>
  )
}

/* ── Guide rail: quiet, contextual instructions on the right of every view ── */

function HelpRail({ children }: { children: React.ReactNode }) {
  return (
    <aside className="hidden xl:flex w-[18.125rem] shrink-0 h-full border-l border-zinc-800/50 bg-zinc-900/20 flex-col relative z-10">
      <div className="flex-1 overflow-auto px-6 py-10 space-y-8">{children}</div>
    </aside>
  )
}

function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[0.625rem] text-zinc-500 font-medium uppercase tracking-wider mb-2.5">{title}</div>
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}

const RailP = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs text-zinc-500 leading-relaxed [&_b]:text-zinc-300 [&_b]:font-medium">{children}</p>
)

const Cmd = ({ children }: { children: React.ReactNode }) => (
  <code className="text-[0.6875rem] font-mono text-zinc-300 bg-zinc-800/70 border border-zinc-700/50 rounded px-1.5 py-0.5 whitespace-nowrap">
    {children}
  </code>
)

function RailSteps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="space-y-2.5">
      {steps.map((st, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <span className="w-[1.125rem] h-[1.125rem] min-w-[1.125rem] h-[1.125rem] rounded-full bg-zinc-800 border border-zinc-700/60 text-zinc-400 text-[0.625rem] flex items-center justify-center mt-px">
            {i + 1}
          </span>
          <span className="text-xs text-zinc-500 leading-relaxed [&_b]:text-zinc-300 [&_b]:font-medium">{st}</span>
        </li>
      ))}
    </ol>
  )
}

const CatchesRail = () => (
  <>
    <RailSection title="What a catch is">
      <RailP>
        Orin checks every PR and issue against this org&apos;s recorded decisions. A <b>catch</b> is a match: the check
        fails (or warns) with a citation to the original decision.
      </RailP>
    </RailSection>
    <RailSection title="How it flows">
      <RailSteps
        steps={[
          <>A PR opens or updates in a connected repo.</>,
          <>Orin grounds it against decision memory. Nothing relevant: the check passes silently.</>,
          <>
            A re-proposal fails the check with the cited decision, right on the PR.
          </>,
        ]}
      />
    </RailSection>
    <RailSection title="States">
      <RailLegend
        items={[
          { color: "bg-red-500", label: "posted: flagged with a citation" },
          { color: "bg-emerald-500", label: "clear: checked, no conflict" },
          { color: "bg-zinc-600", label: "ignored: muted by a maintainer" },
        ]}
      />
    </RailSection>
    <RailSection title="React on the PR">
      <RailP>
        <Cmd>@orinbot good</Cmd> / <Cmd>@orinbot bad</Cmd> rate the catch and reweight memory. <Cmd>@orinbot override</Cmd>{" "}
        supersedes the decision with receipts. <Cmd>@orinbot ignore</Cmd> mutes the thread.
      </RailP>
    </RailSection>
  </>
)

const DecisionsRail = () => (
  <>
    <RailSection title="Where these come from">
      <RailP>
        When a PR or issue <b>closes</b>, Orin reads the thread and extracts the decision: outcome, reasoning, and key
        terms. Docs you upload become memory too.
      </RailP>
    </RailSection>
    <RailSection title="Outcomes">
      <RailLegend
        items={[
          { color: "bg-red-500", label: "rejected: guarded against re-proposal" },
          { color: "bg-emerald-500", label: "accepted: context for recall" },
          { color: "bg-yellow-500", label: "reverted: was accepted, then undone" },
        ]}
      />
    </RailSection>
    <RailSection title="Supersession">
      <RailP>
        Decisions are never deleted, they are <b>superseded</b>. <Cmd>@orinbot override REF &quot;reason&quot;</Cmd> on the
        flagged thread records the reversal and stops future flags.
      </RailP>
    </RailSection>
    <RailSection title="Fastest way to seed one">
      <RailP>
        Close an issue whose last comment states a real decision with reasoning. It appears here within a minute.
      </RailP>
    </RailSection>
  </>
)

const ReposRail = () => (
  <>
    <RailSection title="Connected repos">
      <RailP>
        These are the repositories the GitHub App is installed on, live from GitHub. Each one&apos;s closed PRs and
        issues were backfilled on install.
      </RailP>
    </RailSection>
    <RailSection title="Add or remove">
      <RailP>
        Manage repo access from the GitHub App settings (Integrations → <b>Manage repos</b>). New repos backfill
        automatically; removals stop new checks.
      </RailP>
    </RailSection>
    <RailSection title="Scoping">
      <RailP>
        Decision ids like <Cmd>PR-42</Cmd> are scoped per repo, so identical numbers in different repos never collide.
      </RailP>
    </RailSection>
  </>
)

const RulesRail = () => (
  <>
    <RailSection title="Two scopes">
      <RailP>
        <b>Org-wide</b> rules apply to every connected repo. <b>Repo</b> rules apply only there. A PR is checked against
        both sets, never another repo&apos;s.
      </RailP>
    </RailSection>
    <RailSection title="How they surface">
      <RailP>
        Rules are <b>advisory</b>: when a catch fires and the PR text touches a rule, the rule is cited alongside the
        decision. They never block on their own.
      </RailP>
    </RailSection>
    <RailSection title="From GitHub">
      <RailP>
        <Cmd>@orinbot rule &lt;text&gt;</Cmd> on any thread seeds that repo&apos;s scope. <Cmd>@orinbot rules</Cmd> lists
        both scopes.
      </RailP>
    </RailSection>
    <RailSection title="Writing good rules">
      <RailP>
        One constraint per sentence, imperative, concrete: &quot;Do not add new runtime dependencies without maintainer
        approval.&quot; Indexing takes about a minute.
      </RailP>
    </RailSection>
  </>
)

const DocsRail = () => (
  <>
    <RailSection title="What to upload">
      <RailP>
        Documents that carry decisions: ADRs, CONTRIBUTING, postmortems, design docs, migration notes. Not code; Orin
        reads reasoning, not diffs.
      </RailP>
    </RailSection>
    <RailSection title="What happens">
      <RailSteps
        steps={[
          <>The doc is ingested into the knowledge graph (about a minute).</>,
          <>
            It becomes citable memory for catches, <Cmd>/why</Cmd> in Slack, and MCP agents.
          </>,
          <>With the toggle on, concrete rules are extracted in the same pass.</>,
        ]}
      />
    </RailSection>
    <RailSection title="Repo attribution">
      <RailP>
        Scoping a doc to a repo steers retrieval and citations toward it. <b>Org-wide</b> fits standards and
        cross-cutting ADRs.
      </RailP>
    </RailSection>
  </>
)

const GraphRail = () => (
  <>
    <RailSection title="What you are seeing">
      <RailP>
        Cognee&apos;s knowledge graph of this org&apos;s memory: decisions, entities they touch, and the reasoning
        edges between them, grounded by Orin&apos;s decision ontology.
      </RailP>
    </RailSection>
    <RailSection title="How it grows">
      <RailP>
        Every ingested decision and doc adds nodes and edges. Maintainer <Cmd>good</Cmd>/<Cmd>bad</Cmd> feedback
        reweights the exact nodes behind each verdict, hourly.
      </RailP>
    </RailSection>
    <RailSection title="Interaction">
      <RailP>Drag to pan, scroll to zoom, hover nodes for labels. The graph runs sandboxed for safety.</RailP>
    </RailSection>
  </>
)

const IntegrationsRail = () => (
  <>
    <RailSection title="Isolation model">
      <RailP>
        Every install (GitHub org, Slack workspace, Linear org) gets its <b>own isolated memory</b>. Nothing is shared
        until an admin explicitly links it.
      </RailP>
    </RailSection>
    <RailSection title="Link Slack to this org">
      <RailSteps
        steps={[
          <>
            In Slack: <Cmd>/orin link</Cmd> (workspace admins) returns a one-time code.
          </>,
          <>
            On GitHub: comment <Cmd>@orinbot link CODE</Cmd> on any issue here (write access required).
          </>,
          <>
            Slack&apos;s <Cmd>/why</Cmd> now answers from this org&apos;s memory.
          </>,
        ]}
      />
    </RailSection>
    <RailSection title="Codes">
      <RailP>Single-use, 15-minute expiry, bound to the minting workspace. A leaked used code grants nothing.</RailP>
    </RailSection>
  </>
)

const KeysRail = () => (
  <>
    <RailSection title="What keys unlock">
      <RailP>
        A key authenticates the <b>pre-flight API</b>, the <b>GitHub Action</b>, and <b>MCP clients</b> (Cursor, Claude
        Code, the CLI) against this org&apos;s memory.
      </RailP>
    </RailSection>
    <RailSection title="Scope and storage">
      <RailP>
        Each key is scoped to <b>one repo</b>. Only a SHA-256 hash is stored; the plaintext is shown once at mint.
        Revocation is immediate.
      </RailP>
    </RailSection>
    <RailSection title="Use it">
      <RailSteps
        steps={[
          <>Mint a key for the repo your agent or CI works in.</>,
          <>Paste the MCP snippet from Integrations with your key.</>,
          <>
            In CI: the pre-flight exits non-zero when a change re-proposes a rejected decision.
          </>,
        ]}
      />
    </RailSection>
  </>
)

const SettingsRail = () => (
  <>
    <RailSection title="Delivery modes">
      <RailP>
        <b>check</b> is a status check that can block merges. <b>review</b> posts an inline PR review. <b>comment</b> is
        a plain comment, the gentlest option.
      </RailP>
    </RailSection>
    <RailSection title="Precision knobs">
      <RailP>
        <b>Grounding threshold</b>: shared significant terms required before a decision is even considered; raise it if
        you see false positives. <b>Semantic cutoff</b>: lower is stricter.
      </RailP>
    </RailSection>
    <RailSection title="Philosophy">
      <RailP>
        Orin is precision-first: when evidence is weak it stays <b>silent</b> rather than guessing. Blocking only fires
        on a cited re-proposal.
      </RailP>
    </RailSection>
  </>
)

function RailLegend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className="space-y-1.5">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${it.color}`} />
          <span className="text-xs text-zinc-500">{it.label}</span>
        </div>
      ))}
    </div>
  )
}

const card = "rounded-xl border border-zinc-800 bg-zinc-900/50"

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className={`${card} p-5 relative overflow-hidden`}>
      <div
        className="absolute inset-x-0 top-0 pointer-events-none"
        style={{ height: "40%", background: "linear-gradient(to bottom, rgba(255,255,255,0.04), transparent)" }}
      />
      <div className="text-3xl font-semibold text-white tracking-tight">{value}</div>
      <div className="text-xs text-zinc-500 mt-1.5">{label}</div>
    </div>
  )
}

function EmptyState({
  icon: Icon = Inbox,
  title,
  hint,
  cta,
}: {
  icon?: React.ElementType
  title: string
  hint: string
  cta?: { label: string; href: string }
}) {
  return (
    <div className="h-full min-h-[18.75rem] flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <div className="mx-auto w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
          <Icon className="w-5 h-5 text-zinc-500" />
        </div>
        <p className="text-zinc-200 text-sm font-medium mb-1.5">{title}</p>
        <p className="text-zinc-500 text-xs leading-relaxed mb-5">{hint}</p>
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
            hint="Every PR and issue Orin checks lands here. Close an issue that records a decision, then open a PR that re-proposes it and watch the check fire."
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

      <div className="flex-1 h-full bg-zinc-950 flex overflow-hidden relative">
        <div
          className="absolute top-0 left-0 right-0 pointer-events-none"
          style={{ height: "120px", background: "linear-gradient(to bottom, rgba(255,255,255,0.03), transparent)" }}
        />
        <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto w-full px-8 py-10">
            <div className="grid grid-cols-3 gap-4 mb-10">
              <StatTile label="Decisions tracked" value={overview.metrics.decisionsTracked} />
              <StatTile label="Active rejections" value={overview.metrics.rejectionsActive} />
              <StatTile label="PRs prevented" value={overview.metrics.prsPrevented} />
            </div>

            {!current ? (
              <div className={`${card} p-8`}>
                <EmptyState
                  icon={FileText}
                  title={overview.metrics.decisionsTracked === 0 ? "Memory is empty so far" : "Nothing selected"}
                  hint={
                    overview.metrics.decisionsTracked === 0
                      ? "Orin learns from closed, discussion-rich PRs and issues. Close an issue that records a decision (a rejection with reasoning works best) and it appears in Decisions within a minute."
                      : "Select a catch on the left to see its citation and evidence."
                  }
                />
              </div>
            ) : (
              <div>
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
                  <div className="bg-zinc-900/80 rounded-xl p-5 text-[0.75rem] font-mono mb-5 border border-zinc-800/50 space-y-2">
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
                <div className="flex items-center gap-4 text-xs">
                  <a
                    href={`https://github.com/${current.repo}/${current.kind === "pr" ? "pull" : "issues"}/${current.number}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Open on GitHub
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
        <HelpRail>
          <CatchesRail />
        </HelpRail>
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
      <ListPanel title={repoFilter ? `Decisions · ${repoFilter.split("/")[1] ?? repoFilter}` : "Decisions"}>
        {items.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No decisions recorded"
            hint="Orin extracts decisions from closed PRs and issues. Close an issue that records a real decision (a rejection with reasoning works best) and it shows up here."
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
        <div className="flex-1 h-full bg-zinc-950 flex overflow-hidden">
          <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto w-full px-8 py-10">
            <div className="flex items-center gap-1.5 text-xs mb-4">
              <span className="text-zinc-500">{current.repo || "workspace"}</span>
              <span className="text-zinc-600">›</span>
              <span className="text-emerald-400">Decision memory</span>
              <span className="text-zinc-600">›</span>
              <span className="text-zinc-300">{current.decisionId}</span>
            </div>
            <h2 className="text-white text-xl font-semibold mb-3">{current.title}</h2>
            <div className="flex items-center gap-2 mb-6">
              <span
                className={`text-[0.625rem] px-2 py-0.5 rounded-full uppercase tracking-wide ${
                  current.outcome === "rejected"
                    ? "bg-red-500/15 text-red-400"
                    : current.outcome === "accepted"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-yellow-500/15 text-yellow-400"
                }`}
              >
                {current.outcome}
              </span>
              {current.supersededBy && (
                <span className="text-[0.625rem] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">superseded by {current.supersededBy}</span>
              )}
              {current.decidedAt && <span className="text-zinc-600 text-xs">decided {new Date(current.decidedAt).toLocaleDateString()}</span>}
            </div>
            <div className={`${card} p-5 text-xs text-zinc-300 leading-relaxed mb-6`}>
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
          </div>
          </div>
          <HelpRail>
            <DecisionsRail />
          </HelpRail>
        </div>
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
  const repos = overview.installedRepos.length > 0 ? overview.installedRepos : overview.repos
  const current = selectedRepo && repos.includes(selectedRepo) ? selectedRepo : repos[0]

  if (repos.length === 0)
    return (
      <div className="flex-1 bg-zinc-950">
        <EmptyState
          icon={Layers}
          title="No repos connected"
          hint="Install Orin on a repository; its closed PRs and issues become decision memory."
          cta={{ label: "Install on GitHub", href: GITHUB_APP_URL }}
        />
      </div>
    )

  const decisionCount = (r: string) => decisions.filter((d) => d.repo === r).length
  const currentDecisions = decisions.filter((d) => d.repo === current)

  return (
    <>
      <ListPanel title="Connected repos">
        {repos.map((r) => (
          <ListItem
            key={r}
            title={r}
            subtitle={`${decisionCount(r)} decision${decisionCount(r) === 1 ? "" : "s"} recorded`}
            status={decisionCount(r) > 0 ? "accepted" : "repo"}
            active={r === current}
            onClick={() => onSelectRepo(r)}
          />
        ))}
      </ListPanel>
      {currentDecisions.length === 0 ? (
        <div className="flex-1 h-full bg-zinc-950 flex overflow-hidden">
          <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto w-full px-8 py-10">
            <div className="flex items-center gap-1.5 text-xs mb-6">
              <span className="text-zinc-500">{current}</span>
              <span className="text-zinc-600">›</span>
              <span className="text-emerald-400">Decision memory</span>
            </div>
            <div className={`${card} p-8`}>
              <EmptyState
                icon={FileText}
                title="Connected, no decisions yet"
                hint={`Orin is watching ${current} but hasn't found decision-rich closed threads. It learns the moment a PR or issue closes with a real decision in it, and checks every new PR either way.`}
              />
            </div>
          </div>
          </div>
          <HelpRail>
            <ReposRail />
          </HelpRail>
        </div>
      ) : (
        <DecisionsView decisions={decisions} query={query} repoFilter={current ?? null} selected={selDecision} onSelect={setSelDecision} />
      )}
    </>
  )
}

/* ── Knowledge graph ────────────────────────────────────────────────── */

function GraphView({ inst, account }: { inst: number; account: string }) {
  const [data, setData] = useState<GraphData | null>(null)
  const [status, setStatus] = useState<"loading" | "ok" | "empty" | "error">("loading")

  useEffect(() => {
    let alive = true
    setStatus("loading")
    setData(null)
    api
      .graphData(inst)
      .then((d) => {
        if (!alive) return
        if (!d.nodes.length) setStatus("empty")
        else {
          setData(d)
          setStatus("ok")
        }
      })
      .catch(() => alive && setStatus("error"))
    return () => {
      alive = false
    }
  }, [inst])

  return (
    <FullPanel
      title="Knowledge graph"
      subtitle={`${account}'s decision memory: every decision, the entities Cognee extracted from it, and how they connect. Shared entities pull related decisions together.`}
      rail={<GraphRail />}
    >
      {status === "loading" && <div className="text-zinc-600 text-xs">Building graph…</div>}
      {status === "ok" && data && <ForceGraph data={data} />}
      {status === "empty" && (
        <div className={`${card} p-8`}>
          <EmptyState
            icon={LayoutGrid}
            title="No graph yet"
            hint="The knowledge graph is built from recorded decisions. As soon as Orin ingests the first one (a closed PR or issue with a real decision), it appears here."
          />
        </div>
      )}
      {status === "error" && (
        <div className={`${card} p-8`}>
          <EmptyState icon={LayoutGrid} title="Graph unavailable" hint="Couldn't load the decision graph. Try again in a moment." />
        </div>
      )}
    </FullPanel>
  )
}

type SimNode = GraphData["nodes"][number] & { x: number; y: number; vx: number; vy: number }

const NODE_COLOR = (n: SimNode) =>
  n.type === "repo"
    ? "#3b82f6"
    : n.type === "term"
      ? "#8b5cf6"
      : n.outcome === "rejected"
        ? "#ef4444"
        : n.outcome === "accepted"
          ? "#10b981"
          : "#eab308"
const NODE_R = (n: SimNode) =>
  n.type === "repo" ? 13 : n.type === "decision" ? 8 + Math.min(6, n.degree ?? 1) : 3.5 + Math.min(5, n.degree ?? 1)

function ForceGraph({ data }: { data: GraphData }) {
  const W = 960
  const H = 640
  const nodesRef = useRef<SimNode[]>([])
  const [, setTick] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const drag = useRef<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const alphaRef = useRef(1)

  // neighbor lookup for hover highlighting
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of data.edges) {
      if (!m.has(e.source)) m.set(e.source, new Set())
      if (!m.has(e.target)) m.set(e.target, new Set())
      m.get(e.source)!.add(e.target)
      m.get(e.target)!.add(e.source)
    }
    return m
  }, [data])

  useEffect(() => {
    const N = data.nodes.length
    nodesRef.current = data.nodes.map((n, i) => {
      const a = (i / N) * Math.PI * 2
      return { ...n, x: W / 2 + Math.cos(a) * 220 + (i % 9), y: H / 2 + Math.sin(a) * 170 + (i % 7), vx: 0, vy: 0 }
    })
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]))
    alphaRef.current = 1
    let raf = 0
    const tick = () => {
      const ns = nodesRef.current
      const alpha = alphaRef.current
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const a = ns[i]
          const b = ns[j]
          let dx = a.x - b.x
          let dy = a.y - b.y
          let d2 = dx * dx + dy * dy || 0.01
          const d = Math.sqrt(d2)
          const f = (2600 / d2) * alpha
          const ux = dx / d
          const uy = dy / d
          a.vx += ux * f
          a.vy += uy * f
          b.vx -= ux * f
          b.vy -= uy * f
        }
      }
      for (const e of data.edges) {
        const a = byId.get(e.source)
        const b = byId.get(e.target)
        if (!a || !b) continue
        const L = e.kind === "has-term" ? 74 : e.kind === "in-repo" ? 104 : 130
        let dx = b.x - a.x
        let dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (d - L) * 0.03 * alpha
        const ux = dx / d
        const uy = dy / d
        a.vx += ux * f
        a.vy += uy * f
        b.vx -= ux * f
        b.vy -= uy * f
      }
      for (const n of ns) {
        if (drag.current === n.id) continue
        n.vx += (W / 2 - n.x) * 0.006 * alpha
        n.vy += (H / 2 - n.y) * 0.006 * alpha
        n.vx *= 0.85
        n.vy *= 0.85
        n.x += n.vx
        n.y += n.vy
      }
      alphaRef.current = alpha * 0.986
      setTick((t) => t + 1)
      if (alphaRef.current > 0.02) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [data])

  const toSvg = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H }
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const p = toSvg(e.clientX, e.clientY)
    const n = nodesRef.current.find((x) => x.id === drag.current)
    if (n) {
      n.x = p.x
      n.y = p.y
      n.vx = 0
      n.vy = 0
      alphaRef.current = Math.max(alphaRef.current, 0.3)
      setTick((t) => t + 1)
    }
  }

  const ns = nodesRef.current
  const byId = new Map(ns.map((n) => [n.id, n]))
  const dim = (id: string) => hover !== null && hover !== id && !neighbors.get(hover)?.has(id)

  return (
    <div className={`${card} relative overflow-hidden`}>
      {/* controls */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
        <button onClick={() => setZoom((z) => Math.min(2.2, z + 0.15))} className="w-7 h-7 rounded-md bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 text-sm">+</button>
        <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))} className="w-7 h-7 rounded-md bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 text-sm">−</button>
        <button onClick={() => { setZoom(1); alphaRef.current = 0.6 }} className="h-7 px-2 rounded-md bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 text-[11px]">Reset</button>
      </div>
      {/* stats */}
      <div className="absolute top-3 left-4 z-10 text-[11px] text-zinc-500">
        <span className="text-zinc-300 font-medium">{data.stats.decisions}</span> decisions ·{" "}
        <span className="text-zinc-300 font-medium">{data.stats.entities}</span> entities
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[68vh] block cursor-grab active:cursor-grabbing"
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        <g transform={`translate(${W / 2} ${H / 2}) scale(${zoom}) translate(${-W / 2} ${-H / 2})`}>
          {data.edges.map((e, i) => {
            const a = byId.get(e.source)
            const b = byId.get(e.target)
            if (!a || !b) return null
            const faded = dim(e.source) || dim(e.target)
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={e.kind === "supersedes" ? "#f59e0b" : e.kind === "in-repo" ? "#3b82f6" : "#a1a1aa"}
                strokeOpacity={faded ? 0.04 : e.kind === "has-term" ? 0.14 : 0.28}
                strokeWidth={e.kind === "supersedes" ? 1.6 : 1}
                strokeDasharray={e.kind === "supersedes" ? "4 3" : undefined}
              />
            )
          })}
          {ns.map((n) => {
            const r = NODE_R(n)
            const faded = dim(n.id)
            const showLabel = n.type !== "term" || (n.degree ?? 0) >= 2 || hover === n.id
            return (
              <g key={n.id} opacity={faded ? 0.25 : 1} style={{ cursor: "pointer" }}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill={NODE_COLOR(n)}
                  stroke={hover === n.id ? "#fff" : "rgba(0,0,0,0.4)"}
                  strokeWidth={hover === n.id ? 1.5 : 1}
                  onPointerDown={(e) => {
                    drag.current = n.id
                    ;(e.target as Element).setPointerCapture?.(e.pointerId)
                  }}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                />
                {showLabel && (
                  <text
                    x={n.x}
                    y={n.y + r + 9}
                    textAnchor="middle"
                    fontSize={n.type === "term" ? 7.5 : 9}
                    fill={n.type === "decision" ? "#e4e4e7" : n.type === "repo" ? "#93c5fd" : "#a1a1aa"}
                    className="pointer-events-none select-none"
                    style={{ fontWeight: n.type === "decision" ? 600 : 400 }}
                  >
                    {n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {/* legend */}
      <div className="absolute bottom-3 left-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500" /> rejected</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> accepted</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: "#8b5cf6" }} /> entity</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-500" /> repo</span>
        <span className="text-zinc-600">drag nodes · hover to focus</span>
      </div>
    </div>
  )
}

/* ── Integrations ───────────────────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="text-zinc-500 hover:text-zinc-200 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}

function IntegrationsView({ inst, overview }: { inst: number; overview: Overview | null }) {
  if (!overview) return <Loading />
  const has = (p: string) => overview.links.some((l) => l.platform === p)
  const rows = [
    {
      Icon: SiGithub,
      name: "GitHub App",
      desc: `Required check + @orinbot commands. Connected to ${overview.installedRepos.length} repo${overview.installedRepos.length === 1 ? "" : "s"}.`,
      linked: true,
      href: GITHUB_APP_URL,
      action: "Manage repos",
    },
    {
      Icon: SlackIcon,
      name: "Slack",
      desc: "/why in channels, 🧠 reactions record decisions. Link it to this org's memory with /orin link.",
      linked: has("slack"),
      href: "https://orin-bot.duckdns.org/slack/install",
      action: has("slack") ? "Linked" : "Add to Slack",
    },
    {
      Icon: SiLinear,
      name: "Linear",
      desc: "Agent sessions in issues plus collision warnings on issue create.",
      linked: has("linear"),
      href: "https://orin-bot.duckdns.org/linear/install",
      action: has("linear") ? "Linked" : "Add to Linear",
    },
  ]

  const mcpJson = `{\n  "mcpServers": {\n    "orin": {\n      "url": "https://orin-bot.duckdns.org/mcp",\n      "headers": { "Authorization": "Bearer <your orin_ key>" }\n    }\n  }\n}`

  return (
    <FullPanel title="Integrations" subtitle="One memory, every surface. Each workspace install is an isolated tenant; nothing is shared until you link it." rail={<IntegrationsRail />}>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.name} className={`${card} p-5 flex items-center justify-between gap-6`}>
            <div className="flex items-start gap-3.5 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center shrink-0">
                <r.Icon className="w-[1.125rem] h-[1.125rem] text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-white text-sm font-medium flex items-center gap-2">
                  {r.name}
                  {r.linked && (
                    <span className="flex items-center gap-1 text-[0.625rem] text-emerald-400 font-normal">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> connected
                    </span>
                  )}
                </div>
                <div className="text-zinc-500 text-xs mt-1 leading-relaxed">{r.desc}</div>
              </div>
            </div>
            <a
              href={r.href}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs px-3.5 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              {r.action}
            </a>
          </div>
        ))}

        {/* MCP: syntax-colored config, same treatment as the landing page */}
        <div className={`${card} p-5`}>
          <div className="flex items-start gap-3.5 mb-4">
            <div className="w-9 h-9 rounded-lg bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center shrink-0">
              <KeyRound className="w-[1.125rem] h-[1.125rem] text-white" />
            </div>
            <div>
              <div className="text-white text-sm font-medium">MCP · Cursor, Claude Code, CLI</div>
              <div className="text-zinc-500 text-xs mt-1 leading-relaxed">
                Your coding agents ask Orin before repeating history. Mint a repo-scoped key under Keys, then add this to
                your MCP client config:
              </div>
            </div>
          </div>
          <div className="bg-zinc-950 border border-zinc-800/60 rounded-xl p-5 font-mono text-xs relative">
            <div className="absolute top-4 right-4">
              <CopyButton text={mcpJson} />
            </div>
            <p className="text-zinc-700 mb-3">{"//"}orin-bot.duckdns.org/mcp</p>
            <p>
              <span className="text-zinc-500">{"{"}</span>
            </p>
            <p className="pl-4">
              <span className="text-orange-400/70">&quot;mcpServers&quot;</span>
              <span className="text-zinc-500">: {"{"}</span>
            </p>
            <p className="pl-8">
              <span className="text-orange-400/70">&quot;orin&quot;</span>
              <span className="text-zinc-500">: {"{"}</span>
            </p>
            <p className="pl-12">
              <span className="text-orange-400/70">&quot;url&quot;</span>
              <span className="text-zinc-500">: </span>
              <span className="text-green-400/70">&quot;https://orin-bot.duckdns.org/mcp&quot;</span>
              <span className="text-zinc-500">,</span>
            </p>
            <p className="pl-12">
              <span className="text-orange-400/70">&quot;headers&quot;</span>
              <span className="text-zinc-500">: {"{ "}</span>
              <span className="text-orange-400/70">&quot;Authorization&quot;</span>
              <span className="text-zinc-500">: </span>
              <span className="text-green-400/70">&quot;Bearer &lt;your orin_ key&gt;&quot;</span>
              <span className="text-zinc-500">{" }"}</span>
            </p>
            <p className="pl-8">
              <span className="text-zinc-500">{"}"}</span>
            </p>
            <p className="pl-4">
              <span className="text-zinc-500">{"}"}</span>
            </p>
            <p>
              <span className="text-zinc-500">{"}"}</span>
            </p>
          </div>
        </div>

        <div className={`${card} p-5`}>
          <div className="text-white text-sm font-medium mb-1.5">Cross-platform linking</div>
          <p className="text-zinc-500 text-xs leading-relaxed">
            To make Slack answer from this org&apos;s GitHub memory: in Slack run{" "}
            <span className="text-zinc-300 font-mono">/orin link</span>, then have someone with write access comment{" "}
            <span className="text-zinc-300 font-mono">@orinbot link CODE</span> on any issue or PR in this org. Codes are
            single-use and expire in 15 minutes.
          </p>
        </div>
      </div>
    </FullPanel>
  )
}

/* ── Keys ───────────────────────────────────────────────────────────── */

function KeysView({ inst, overview }: { inst: number; overview: Overview | null }) {
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

  const mintButton = (
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
        <button className="px-4 py-2 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-xs shrink-0">
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
              <code className="text-[0.6875rem] text-emerald-400 break-all flex-1">{minted}</code>
              <CopyButton text={minted} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {overview && overview.installedRepos.length > 0 ? (
              <Select value={repo} onValueChange={setRepo}>
                <SelectTrigger className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs">
                  <SelectValue placeholder="Choose a connected repo" />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-200">
                  {overview.installedRepos.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                placeholder="repo (owner/name)"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs"
              />
            )}
            <Input
              placeholder="label (e.g. ci-gate, cursor)"
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
  )

  return (
    <FullPanel
      title="Keys"
      subtitle="Repo-scoped orin_ keys authenticate the CI pre-flight, the GitHub Action, and MCP clients. Stored hashed; shown once."
      action={mintButton}
      rail={<KeysRail />}
    >
      {!keys ? (
        <p className="text-zinc-600 text-xs">Loading…</p>
      ) : keys.length === 0 ? (
        <div className={`${card} p-8`}>
          <EmptyState
            icon={KeyRound}
            title="No keys yet"
            hint="Mint a key to let CI or your IDE agents query this org's memory. Each key is scoped to a single repo."
          />
        </div>
      ) : (
        <div className={`${card} overflow-hidden`}>
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/80 text-zinc-500">
              <tr>
                <th className="text-left px-5 py-3 font-medium">Label</th>
                <th className="text-left px-5 py-3 font-medium">Repo</th>
                <th className="text-left px-5 py-3 font-medium">Created</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.keyHash} className="border-t border-zinc-800/50 text-zinc-300">
                  <td className="px-5 py-3">{k.label || <span className="text-zinc-600">(no label)</span>}</td>
                  <td className="px-5 py-3 font-mono text-[0.6875rem]">{k.repo}</td>
                  <td className="px-5 py-3 text-zinc-500">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3">
                    {k.revokedAt ? (
                      <span className="text-zinc-600">revoked</span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-emerald-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> active
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {!k.revokedAt && (
                      <button
                        onClick={() => api.revokeKey(inst, k.keyHash).then(refresh)}
                        className="text-red-400/80 hover:text-red-300 text-[0.6875rem]"
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
    <div className="flex items-center justify-between gap-8 px-5 py-4 border-b border-zinc-800/50 last:border-b-0">
      <div>
        <div className="text-zinc-200 text-xs font-medium">{label}</div>
        {hint && <div className="text-zinc-600 text-[0.6875rem] mt-1 leading-relaxed max-w-md">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )

  return (
    <FullPanel
      title="Settings"
      subtitle="How Orin delivers and judges catches for this installation."
      rail={<SettingsRail />}
      action={
        <div className="flex items-center gap-3">
          {saved && <span className="text-emerald-400 text-xs">Saved</span>}
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-xs disabled:opacity-40 shrink-0"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      }
    >
      <div className={card}>
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
        <Row label="Auto-comment" hint="Let Orin write on PRs and issues (off = silent, log-only)">
          <Switch checked={s.autoComment} onCheckedChange={(v) => setS({ ...s, autoComment: v })} />
        </Row>
        <Row label="LLM engine" hint="Extraction and judgment run on DeepSeek for every workspace. Fixed, not configurable.">
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300 px-3 py-1.5 rounded-md bg-zinc-800/60 border border-zinc-700/50">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> DeepSeek
          </span>
        </Row>
        <Row label="Grounding threshold" hint="Minimum shared significant terms before a decision is even considered (the precision gate)">
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
        <div className="px-5 py-4">
          <div className="text-zinc-200 text-xs font-medium mb-2">Custom instructions</div>
          <Textarea
            value={s.customInstructions}
            onChange={(e) => setS({ ...s, customInstructions: e.target.value })}
            placeholder="Extra guidance for Orin's judgment, e.g. what counts as a decision in this org."
            className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs min-h-20"
          />
        </div>
      </div>
    </FullPanel>
  )
}


/* ── Rules ──────────────────────────────────────────────────────────── */

function RulesView({ inst, overview }: { inst: number; overview: Overview | null }) {
  const [scope, setScope] = useState<string>("") // '' = org-wide
  const [rules, setRules] = useState<string[] | null>(null)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(
    () => api.rules(inst, scope || undefined).then((r) => setRules(r.rules)).catch(() => setRules([])),
    [inst, scope],
  )
  useEffect(() => {
    setRules(null)
    refresh()
  }, [refresh])

  const submit = async () => {
    setBusy(true)
    setError(null)
    setAdded(null)
    try {
      const r = await api.addRule(inst, text.trim(), scope || undefined)
      setAdded(r.rules)
      if (r.rules.length > 0) setText("")
      setTimeout(refresh, 4000) // indexing runs in the background; refresh shortly after
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <FullPanel
      title="Rules"
      subtitle="Standing constraints Orin enforces alongside decision memory. Org-wide rules apply to every repo; repo rules apply only there. @orinbot rule on GitHub seeds that repo's scope."
      rail={<RulesRail />}
      action={
        <Select value={scope || "__org__"} onValueChange={(v) => setScope(v === "__org__" ? "" : v)}>
          <SelectTrigger className="w-52 bg-zinc-950 border-zinc-800 text-zinc-200 text-xs h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-200">
            <SelectItem value="__org__">Org-wide (all repos)</SelectItem>
            {(overview?.installedRepos ?? []).map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <div className={`${card} p-5 mb-4`}>
        <div className="text-zinc-200 text-xs font-medium mb-2">Add rules</div>
        <p className="text-zinc-600 text-[0.6875rem] mb-3 leading-relaxed">
          Write constraints in plain language ("Do not add new runtime dependencies without maintainer approval"). Orin
          extracts each atomic rule and indexes it.
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="No new runtime dependencies without approval. All database access goes through the repository layer. Never log request bodies."
          className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs min-h-20 mb-3"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={submit}
            disabled={busy || !text.trim()}
            className="px-4 py-2 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> {busy ? "Extracting…" : "Extract & add"}
          </button>
          {error && <span className="text-red-400 text-xs">{error}</span>}
        </div>
        {added && (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            {added.length === 0 ? (
              <p className="text-zinc-500 text-xs">No concrete rules found in that text. Phrase it as a constraint.</p>
            ) : (
              <>
                <p className="text-emerald-400 text-xs mb-2">
                  Extracted {added.length} rule{added.length === 1 ? "" : "s"} (indexing in the background):
                </p>
                <ul className="space-y-1.5">
                  {added.map((r) => (
                    <li key={r} className="text-zinc-300 text-xs flex items-start gap-2">
                      <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-px" /> {r}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {!rules ? (
        <p className="text-zinc-600 text-xs">Loading…</p>
      ) : rules.length === 0 ? (
        <div className={`${card} p-8`}>
          <EmptyState
            icon={BookOpen}
            title={scope ? `No rules for ${scope} yet` : "No org-wide rules yet"}
            hint="Rules you add here (or via @orinbot rule on GitHub) appear on catches when a PR touches them. Newly added rules can take a minute to index."
          />
        </div>
      ) : (
        <div className={`${card} divide-y divide-zinc-800/50`}>
          {rules.map((r) => (
            <div key={r} className="px-5 py-3.5 flex items-start gap-3">
              <BookOpen className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" />
              <span className="text-zinc-300 text-xs leading-relaxed">{r}</span>
            </div>
          ))}
        </div>
      )}
    </FullPanel>
  )
}

/* ── Docs ───────────────────────────────────────────────────────────── */

function DocsView({ inst, overview }: { inst: number; overview: Overview | null }) {
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [repo, setRepo] = useState<string>("") // '' = org-wide
  const [extract, setExtract] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ filename: string; rules: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [docs, setDocs] = useState<Array<{ filename: string; title: string; repo: string; createdAt: string }> | null>(null)

  const refreshDocs = useCallback(() => api.docs(inst).then((r) => setDocs(r.docs)).catch(() => setDocs([])), [inst])
  useEffect(() => {
    refreshDocs()
  }, [refreshDocs])

  const onFile = (f: File | null) => {
    if (!f) return
    if (!title) setTitle(f.name.replace(/\.(md|txt|markdown)$/i, ""))
    const reader = new FileReader()
    reader.onload = () => setContent(String(reader.result ?? ""))
    reader.readAsText(f)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await api.uploadDoc(inst, title.trim(), content.trim(), extract, repo || undefined)
      setResult({ filename: r.filename, rules: r.rules })
      setTitle("")
      setContent("")
      refreshDocs()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <FullPanel
      title="Docs"
      subtitle="Feed Orin the documents that carry decisions: ADRs, CONTRIBUTING, postmortems, design docs. They become citable memory for catches, /why, and your IDE agents."
      rail={<DocsRail />}
    >
      <div className={`${card} p-5`}>
        <div className="grid gap-3">
          <Input
            placeholder="Title (e.g. ADR-007: Why we run one Postgres)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs"
          />
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste the document, or pick a file below."
            className="bg-zinc-950 border-zinc-800 text-zinc-200 text-xs min-h-40 font-mono"
          />
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <label className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer inline-flex items-center gap-2">
              <Upload className="w-3.5 h-3.5" />
              Choose .md / .txt file
              <input type="file" accept=".md,.txt,.markdown" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
            </label>
            <Select value={repo || "__org__"} onValueChange={(v) => setRepo(v === "__org__" ? "" : v)}>
              <SelectTrigger className="w-48 bg-zinc-950 border-zinc-800 text-zinc-200 text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-200">
                <SelectItem value="__org__">Org-wide</SelectItem>
                {(overview?.installedRepos ?? []).map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
              <Switch checked={extract} onCheckedChange={setExtract} />
              Also extract coding rules
            </label>
            <button
              onClick={submit}
              disabled={busy || !title.trim() || !content.trim()}
              className="px-4 py-2 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-xs disabled:opacity-40"
            >
              {busy ? "Uploading…" : "Teach Orin"}
            </button>
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
      </div>

      {result && (
        <div className={`${card} p-5 mt-4`}>
          <p className="text-emerald-400 text-xs mb-1.5">
            Accepted as {result.filename}. Orin is reading it now; it becomes part of the knowledge graph and citable
            memory within about a minute.
          </p>
          {result.rules.length > 0 && (
            <>
              <p className="text-zinc-400 text-xs mt-3 mb-2">Rules extracted from the doc:</p>
              <ul className="space-y-1.5">
                {result.rules.map((r) => (
                  <li key={r} className="text-zinc-300 text-xs flex items-start gap-2">
                    <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-px" /> {r}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {docs && docs.length > 0 && (
        <div className={`${card} mt-4 divide-y divide-zinc-800/50`}>
          <div className="px-5 py-3 text-zinc-500 text-[0.6875rem] font-medium uppercase tracking-wider">Uploaded docs</div>
          {docs.map((d) => (
            <div key={d.filename} className="px-5 py-3.5 flex items-center gap-3">
              <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              <span className="text-zinc-300 text-xs flex-1 truncate">{d.title}</span>
              <span className="text-[0.625rem] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">{d.repo || "org-wide"}</span>
              <span className="text-zinc-600 text-[0.625rem]">{new Date(d.createdAt).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
    </FullPanel>
  )
}
