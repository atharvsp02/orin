"use client"

import { CirclePower } from "lucide-react"

export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800 bg-[#09090B]/80 backdrop-blur-md">
      <div className="w-full flex justify-center px-6 py-4">
        <div className="w-full max-w-4xl flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CirclePower className="w-5 h-5 text-white" />
            <span className="text-white font-semibold">Orin</span>
          </div>
          <div className="hidden md:flex items-center gap-8">
            <a href="/#product" className="text-sm text-zinc-400 hover:text-white transition-colors">
              Product
            </a>
            <a href="/#how-it-works" className="text-sm text-zinc-400 hover:text-white transition-colors">
              How it works
            </a>
            <a href="/#integrations" className="text-sm text-zinc-400 hover:text-white transition-colors">
              Integrations
            </a>
            <a href="/dashboard" className="text-sm text-zinc-400 hover:text-white transition-colors">
              Dashboard
            </a>
            <a href="https://github.com/apps/orinbot" target="_blank" rel="noreferrer" className="text-sm text-zinc-400 hover:text-white transition-colors">
              GitHub
            </a>
          </div>
          <div className="flex items-center gap-4">
            <a href="/dashboard" className="text-sm text-zinc-400 hover:text-white transition-colors">
              Log in
            </a>
            <a
              href="https://github.com/apps/orinbot"
              className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 px-3.5 py-1.5 rounded-md border border-zinc-700 transition-colors"
            >
              Install Orin
            </a>
          </div>
        </div>
      </div>
    </nav>
  )
}
