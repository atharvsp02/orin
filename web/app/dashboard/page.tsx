"use client"

// /dashboard: session gate → sign-in screen (GitHub OAuth) → onboarding (no installs) → shell.
// All state comes from /v1/me; there is no client-side auth logic beyond reading it.
import { useEffect, useState } from "react"
import { CirclePower, ExternalLink } from "lucide-react"
import { SiGithub } from "@icons-pack/react-simple-icons"
import { api, ApiError, type Me } from "@/lib/orin-api"
import { DashboardShell } from "@/components/dashboard-shell"

const GITHUB_APP_URL = "https://github.com/apps/orinbot"

export default function DashboardPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [state, setState] = useState<"loading" | "signedout" | "ready" | "error">("loading")

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
          Continue with GitHub. You&apos;ll see the installations you administer; Orin never stores your GitHub token.
        </p>
        <a
          href={api.signInUrl}
          className="flex items-center gap-2.5 px-5 py-2.5 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-sm"
        >
          <SiGithub className="w-4 h-4" />
          Continue with GitHub
        </a>
        <a href="/" className="mt-6 text-zinc-500 hover:text-zinc-300 text-xs transition-colors">
          Back to orin.dev
        </a>
      </Centered>
    )
  }

  if (me && me.installations.length === 0) {
    return (
      <Centered>
        <CirclePower className="w-8 h-8 text-white mb-6" />
        <h1 className="text-white text-2xl font-medium mb-2">Almost there, {me.login}</h1>
        <p className="text-zinc-500 text-sm mb-8 max-w-md text-center">
          Orin isn&apos;t installed on any repository you administer yet. Install it, let it learn from your closed PRs
          and issues, then come back and refresh.
        </p>
        <div className="flex items-center gap-3">
          <a
            href={GITHUB_APP_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-5 py-2.5 bg-white text-zinc-900 font-medium rounded-lg hover:bg-zinc-100 transition-colors text-sm"
          >
            Install on GitHub <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => location.reload()}
            className="px-5 py-2.5 border border-zinc-700 text-white font-medium rounded-lg hover:bg-zinc-800 transition-colors text-sm"
          >
            Refresh
          </button>
        </div>
        <a href={api.logoutUrl} className="mt-6 text-zinc-500 hover:text-zinc-300 text-xs transition-colors">
          Sign out
        </a>
      </Centered>
    )
  }

  return me ? <DashboardShell me={me} /> : null
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ backgroundColor: "#09090B" }}>
      {children}
    </div>
  )
}
