"use client"

import { useEffect, useState } from "react"
import { CirclePower, ExternalLink, RefreshCw, LogOut } from "lucide-react"
import { SiGithub, SiLinear } from "@icons-pack/react-simple-icons"
import { Slack } from "lucide-react"
import { api, ApiError, type Me } from "@/lib/orin-api"
import { DashboardShell } from "@/components/dashboard-shell"

const GITHUB_APP_URL = "https://github.com/apps/orinbot"
const REFRESH_URL = "/v1/auth/github"

export default function DashboardPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [state, setState] = useState<"loading" | "signedout" | "ready" | "error">("loading")

  // The dashboard reads best ~10% larger. Scaling the root font-size scales every rem-based
  // size (type, spacing, icons, panels, portals) together, exactly like browser zoom.
  useEffect(() => {
    document.documentElement.style.fontSize = "110%"
    return () => {
      document.documentElement.style.fontSize = ""
    }
  }, [])

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m)
        setState("ready")
      })
      .catch((e) => setState(e instanceof ApiError && e.status === 401 ? "signedout" : "error"))
  }, [])

  if (state === "loading") {
    return (
      <Centered>
        <p className="text-zinc-600 text-sm">Loading…</p>
      </Centered>
    )
  }

  if (state === "error") {
    return (
      <Centered>
        <CirclePower className="w-8 h-8 text-white mb-4" />
        <p className="text-zinc-300 text-sm mb-1">Couldn&apos;t reach the Orin API</p>
        <p className="text-zinc-500 text-xs">Try again in a moment.</p>
      </Centered>
    )
  }

  if (state === "signedout") {
    return (
      <Centered>
        <CirclePower className="w-8 h-8 text-white mb-6" />
        <h1 className="text-white text-2xl font-medium mb-2">Sign in to Orin</h1>
        <p className="text-zinc-500 text-sm mb-8 max-w-sm text-center">
          GitHub currently verifies dashboard access. Your workspace can connect GitHub, Slack, Linear, or any
          combination of them.
        </p>
        <a
          href={api.signInUrl}
          className="flex items-center gap-2.5 px-5 py-2.5 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-sm"
        >
          <SiGithub className="w-4 h-4" />
          Continue with GitHub
        </a>
        <a href="/" className="mt-6 text-zinc-500 hover:text-zinc-300 text-xs transition-colors">
          Back to home
        </a>
      </Centered>
    )
  }

  if (me && me.workspaces.length === 0) return <ConnectHub me={me} />

  return me ? <DashboardShell me={me} /> : null
}

/* ── Connect hub: the dashboard for a signed-in user with nothing connected yet ── */

function ConnectHub({ me }: { me: Me }) {
  const cards = [
    {
      Icon: SiGithub,
      name: "GitHub",
      what: "Capture decisions from closed pull requests and issues, then check new changes against that memory.",
      how: "Install the app on selected repositories. Orin creates an isolated workspace and starts learning from them.",
      href: GITHUB_APP_URL,
      action: "Connect GitHub",
    },
    {
      Icon: Slack,
      name: "Slack",
      what: "Ask questions in channels and record decisions from the conversations where they happen.",
      how: "Install it for standalone workspace memory, or link it later to an existing Orin workspace.",
      href: "https://orin-bot.duckdns.org/slack/install",
      action: "Connect Slack",
    },
    {
      Icon: SiLinear,
      name: "Linear",
      what: "Ask for decision context in issues and catch planned work that conflicts with existing memory.",
      how: "Authorize Orin for your Linear organization. It creates isolated workspace memory automatically.",
      href: "https://orin-bot.duckdns.org/linear/install",
      action: "Connect Linear",
    },
  ]

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#09090B" }}>
      {/* slim dashboard header, same theme as the shell */}
      <div className="border-b border-zinc-800/50 bg-zinc-900/40">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CirclePower className="w-5 h-5 text-white" />
            <span className="text-white font-semibold text-sm">Orin</span>
            <span className="text-zinc-600 text-xs ml-2">Dashboard</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-zinc-500 text-xs">{me.login}</span>
            <a href={api.logoutUrl} className="text-zinc-500 hover:text-zinc-300 transition-colors" title="Sign out">
              <LogOut className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-white text-2xl font-medium mb-2">Connect your tools</h1>
        <p className="text-zinc-500 text-sm mb-3 max-w-xl">
          Start with any source. Each connector creates isolated workspace memory, and connectors can share one memory
          when your team wants the same answers everywhere.
        </p>
        <a
          href={REFRESH_URL}
          className="inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors mb-10"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Connected GitHub? Refresh workspaces
        </a>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cards.map((c) => (
            <div
              key={c.name}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 flex flex-col"
            >
              <div className="flex items-center gap-2.5 mb-3">
                <c.Icon className="w-5 h-5 text-white" />
                <span className="text-white text-sm font-medium">{c.name}</span>
              </div>
              <p className="text-zinc-400 text-xs leading-relaxed mb-2">{c.what}</p>
              <p className="text-zinc-600 text-xs leading-relaxed mb-4">{c.how}</p>
              <a
                href={c.href}
                target="_blank"
                rel="noreferrer"
                className="mt-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors w-fit border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              >
                {c.action} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          ))}
        </div>

        <p className="text-zinc-600 text-xs mt-8">
          Slack and Linear start working after installation. Connected GitHub workspaces appear here after you{" "}
          <a href={REFRESH_URL} className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2">
            refresh access
          </a>{" "}
          to open your workspace.
        </p>
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ backgroundColor: "#09090B" }}>
      {children}
    </div>
  )
}
