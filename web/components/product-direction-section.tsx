"use client"

import { ChevronRight } from "lucide-react"

export function ProductDirectionSection() {
  return (
    <section id="how-it-works" className="relative py-40 px-6 md:px-12 lg:px-24">
      {/* Gradient overlay at top */}
      <div
        className="absolute inset-x-0 top-0 pointer-events-none"
        style={{
          height: "20%",
          background: "linear-gradient(to bottom, rgba(255,255,255,0.05), transparent 100%)",
        }}
      />

      <div className="max-w-6xl mx-auto">
        {/* Section label */}
        <div className="flex items-center gap-2 mb-6">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span className="text-zinc-400 text-sm">Decision memory and supersession</span>
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        </div>

        {/* Section heading */}
        <h2
          className="text-3xl sm:text-4xl md:text-5xl lg:text-[56px] font-medium text-white mb-8 max-w-3xl"
          style={{
            letterSpacing: "-0.0325em",
            fontVariationSettings: '"opsz" 28',
            fontWeight: 538,
            lineHeight: 1.1,
          }}
        >
          Never re-litigate a decision
        </h2>

        {/* Description */}
        <p className="text-zinc-400 text-lg max-w-md mb-16">
          <span className="text-white font-medium">Every closed PR and issue becomes memory.</span> Orin extracts
          the decision, the reasoning, and the discussion around it, then guards it going forward.
        </p>

        {/* 3D Timeline Visualization */}
        <div
          className="relative w-full mb-16"
          style={{
            perspective: "1200px",
          }}
        >
          <div
            className="relative"
            style={{
              transform: "rotateX(50deg) rotateZ(-35deg)",
              transformStyle: "preserve-3d",
              transformOrigin: "center center",
            }}
          >
            {/* Timeline ruler with tick marks */}
            <div className="relative h-[400px]">
              {/* Diagonal dashed line */}
              <div
                className="absolute w-[1px] bg-zinc-600/50"
                style={{
                  height: "600px",
                  left: "55%",
                  top: "-100px",
                  transform: "rotate(0deg)",
                  backgroundImage:
                    "repeating-linear-gradient(to bottom, transparent, transparent 4px, rgba(113, 113, 122, 0.5) 4px, rgba(113, 113, 122, 0.5) 8px)",
                }}
              />

              {/* Timeline header with dates and tick marks */}
              <div className="absolute top-0 left-0 right-0 flex items-end">
                {/* Tick marks row */}
                <div className="flex items-end gap-[3px] absolute bottom-0 left-[5%] right-0">
                  {Array.from({ length: 60 }).map((_, i) => (
                    <div
                      key={i}
                      className="bg-zinc-600/60"
                      style={{
                        width: "1px",
                        height: i % 7 === 0 ? "16px" : "8px",
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Date labels */}
              <div className="absolute text-zinc-500 text-sm" style={{ left: "8%", top: "80px" }}>
                30
              </div>
              <div className="absolute text-zinc-500 text-sm" style={{ left: "18%", top: "55px" }}>
                AUG 3
              </div>
              <div className="absolute text-zinc-500 text-sm" style={{ left: "32%", top: "35px" }}>
                10
              </div>
              <div className="absolute text-zinc-500 text-sm" style={{ left: "48%", top: "15px" }}>
                17
              </div>
              <div
                className="absolute px-3 py-1 rounded-md bg-zinc-700/80 text-zinc-300 text-sm font-medium"
                style={{ left: "58%", top: "-10px" }}
              >
                AUG 22
              </div>
              <div className="absolute text-zinc-500 text-sm" style={{ left: "70%", top: "-5px" }}>
                24
              </div>
              <div className="absolute text-zinc-500/50 text-sm" style={{ left: "88%", top: "-25px" }}>
                SEP
              </div>

              {/* Project bars */}
              {/* Realtime inference bar */}
              <div
                className="absolute rounded-lg bg-zinc-800/90 border border-zinc-700/50 px-4 py-3 flex items-center gap-3"
                style={{
                  left: "5%",
                  top: "100px",
                  width: "45%",
                  height: "48px",
                }}
              >
                <div className="w-4 h-4 rotate-45 bg-zinc-500/60" />
                <span className="text-zinc-300 text-sm font-medium">ISSUE-42: Redis rejected</span>
                <div
                  className="absolute w-5 h-5 rotate-45 border-2 border-green-500 bg-transparent"
                  style={{ right: "15%", top: "50%", transform: "translateY(-50%) rotate(45deg)" }}
                />
              </div>

              {/* Prototype bar */}
              <div
                className="absolute rounded-lg bg-zinc-800/70 border border-zinc-700/40 px-4 py-3 flex items-center gap-3"
                style={{
                  left: "15%",
                  top: "155px",
                  width: "25%",
                  height: "44px",
                }}
              >
                <div className="w-3 h-3 rotate-45 bg-zinc-600/60" />
                <span className="text-zinc-500 text-sm">PR-214 caught</span>
              </div>

              {/* Beta bar */}
              <div
                className="absolute rounded-lg bg-zinc-800/90 border border-zinc-700/50 px-4 py-3 flex items-center justify-between"
                style={{
                  left: "45%",
                  top: "155px",
                  width: "45%",
                  height: "48px",
                }}
              >
                <span className="text-zinc-400 text-sm">Rule: no new deps</span>
                <div className="flex gap-0.5">
                  <div className="w-2.5 h-2.5 rotate-45 bg-zinc-500/60" />
                  <div className="w-2.5 h-2.5 rotate-45 bg-zinc-500/60" />
                  <div className="w-2.5 h-2.5 rotate-45 bg-zinc-500/60" />
                </div>
              </div>

              {/* RLHF fine tuning bar */}
              <div
                className="absolute rounded-lg bg-zinc-800/70 border border-zinc-700/40 px-4 py-3 flex items-center justify-between"
                style={{
                  left: "35%",
                  top: "240px",
                  width: "28%",
                  height: "48px",
                }}
              >
                <span className="text-zinc-400 text-sm">OVERRIDE-7 supersedes</span>
                <div className="flex gap-0.5">
                  <div className="w-2.5 h-2.5 rotate-45 bg-zinc-500/60" />
                  <div className="w-2.5 h-2.5 rotate-45 bg-zinc-500/60" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom two-column section */}
        <div className="grid grid-cols-1 md:grid-cols-2">
          {/* Left column - Decisions tracked end to end */}
          <div className="border-t border-r border-b border-zinc-800 pt-10 pr-10 pb-16">
            <h3 className="text-xl font-medium text-zinc-200 mb-3">Decisions tracked end to end</h3>
            <p className="text-zinc-500 text-base leading-relaxed mb-8">
              Every decision carries its outcome, reasoning, key terms, and source thread in one queryable graph.
            </p>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h4 className="text-lg font-medium text-zinc-200 mb-5">Decision ISSUE-42</h4>

              {/* Properties row */}
              <div className="flex items-center gap-4 mb-4">
                <span className="text-zinc-500 text-sm w-20">Properties</span>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 text-zinc-300 text-xs">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    Rejected
                  </span>
                  <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 text-zinc-300 text-xs">
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="2" y="2" width="12" height="12" rx="2" />
                    </svg>
                    acme/api
                  </span>
                  <div className="flex -space-x-1.5">
                    <div className="w-5 h-5 rounded-full bg-zinc-600 border border-zinc-900" />
                    <div className="w-5 h-5 rounded-full bg-zinc-500 border border-zinc-900" />
                    <div className="w-5 h-5 rounded-full bg-zinc-700 border border-zinc-900" />
                  </div>
                </div>
              </div>

              {/* Resources row */}
              <div className="flex items-center gap-4 mb-4">
                <span className="text-zinc-500 text-sm w-20">Evidence</span>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 text-zinc-300 text-xs">
                    <span className="text-purple-400">🚩</span>
                    Issue thread
                  </span>
                  <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 text-zinc-400 text-xs">
                    <span className="text-yellow-500">⚠</span>
                    4 comments
                  </span>
                </div>
              </div>

              {/* Milestones row */}
              <div className="flex items-start gap-4">
                <span className="text-zinc-500 text-sm w-20 pt-1">Reasoning</span>
                <div className="flex flex-col gap-2">
                  <span className="flex items-center gap-2 text-zinc-300 text-sm">
                    <span className="w-2.5 h-2.5 rotate-45 bg-purple-500" />
                    Extra service to run <span className="text-zinc-500">ops</span>
                  </span>
                  <span className="flex items-center gap-2 text-zinc-300 text-sm">
                    <span className="w-2.5 h-2.5 rotate-45 bg-purple-500" />
                    Postgres views suffice <span className="text-zinc-500">cited</span>
                  </span>
                  <span className="flex items-center gap-2 text-zinc-400 text-sm">
                    <span className="w-2.5 h-2.5 rotate-45 border border-zinc-500 bg-transparent" />
                    Superseded by <span className="text-zinc-500">none</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right column - Verdicts with receipts */}
          <div className="border-t border-b border-zinc-800 pt-10 pl-10 pb-16">
            <h3 className="text-xl font-medium text-zinc-200 mb-3">Verdicts with receipts</h3>
            <p className="text-zinc-500 text-base leading-relaxed mb-8">
              When a PR re-proposes a rejection, the check fails with the citation and a link to the original thread.
            </p>

            <div className="relative h-48">
              {/* Off track card (back) */}
              <div
                className="absolute rounded-lg bg-zinc-800/40 border border-zinc-700/30 px-4 py-2"
                style={{ top: 0, left: "10%", width: "80%" }}
              >
                <span className="flex items-center gap-2 text-zinc-500 text-sm">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                  No conflict
                </span>
              </div>

              {/* At risk card (middle) */}
              <div
                className="absolute rounded-lg bg-zinc-800/60 border border-zinc-700/40 px-4 py-2"
                style={{ top: "30px", left: "5%", width: "85%" }}
              >
                <span className="flex items-center gap-2 text-zinc-400 text-sm">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
                  Advisory
                </span>
              </div>

              {/* On track card (front) */}
              <div
                className="absolute rounded-xl bg-zinc-800/90 border border-zinc-700/50 px-5 py-4"
                style={{ top: "60px", left: 0, width: "95%" }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center">
                    <svg className="w-3 h-3 text-green-500" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                    </svg>
                  </span>
                  <span className="text-green-500 font-medium text-sm">Caught</span>
                </div>
                <p className="text-zinc-300 text-sm mb-3">PR-214 re-proposes ISSUE-42: Redis adds ops burden</p>
                <span className="text-zinc-500 text-xs">2 min ago</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 border-b border-zinc-800">
          {/* Left column - Feature list */}
          <div className="border-r border-zinc-800 pt-16 pr-10 pb-16 flex flex-col justify-center">
            <h3 className="text-2xl font-medium text-zinc-200 mb-8 leading-tight">
              Teach Orin how
              <br />
              your team decides
            </h3>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div className="w-1 h-5 rounded-full bg-green-500" />
                <span className="text-zinc-200 font-medium">@orin rule: seed standing constraints</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-1 h-5 rounded-full bg-green-500/50" />
                <span className="text-zinc-400">@orin override: supersede with receipts</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-1 h-5 rounded-full bg-green-500/30" />
                <span className="text-zinc-500">@orin good / bad: tune precision</span>
              </div>
            </div>
          </div>

          {/* Right column - Document mockup */}
          <div className="pt-10 pl-10 pb-16">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 text-zinc-400 text-sm">
                <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.5 2A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0012.5 2h-9z" />
                </svg>
                <span>acme/api</span>
                <span className="text-zinc-600">›</span>
                <span>Decision log</span>
                <span className="ml-auto text-zinc-600">•••</span>
              </div>

              {/* Content */}
              <div className="p-5">
                {/* Icon */}
                <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center mb-4">
                  <svg className="w-5 h-5 text-green-500" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 8a2 2 0 100-4 2 2 0 000 4zM8 9c-2.67 0-8 1.34-8 4v1h16v-1c0-2.66-5.33-4-8-4z" />
                  </svg>
                </div>

                {/* Title with cursor */}
                <div className="mb-3 relative inline-block">
                  <span className="text-zinc-200 text-lg font-medium">Recorded:</span>
                  <span className="relative mx-1">
                    <span className="text-zinc-200 text-lg font-medium bg-green-500/20 px-0.5">ISSUE-42</span>
                    <span className="absolute -top-4 right-0 px-1.5 py-0.5 rounded text-[10px] bg-green-600 text-white">
                      orin
                    </span>
                  </span>
                </div>

                {/* Description with cursor */}
                <p className="text-zinc-400 text-sm leading-relaxed mb-6">
                  Adding Redis as a caching layer was{" "}
                  <span className="relative inline">
                    <span className="bg-purple-500/20 px-0.5">rej</span>
                    <span className="absolute -bottom-4 left-0 px-1.5 py-0.5 rounded text-[10px] bg-purple-600 text-white">
                      maya
                    </span>
                  </span>
                  ected. It adds an extra service to operate, and Postgres materialized views already cover our
                  caching needs.
                </p>

                {/* Placeholder text lines */}
                <div className="flex flex-col gap-2 mt-8">
                  <div className="flex gap-2 flex-wrap">
                    <div className="h-2 bg-zinc-700/50 rounded w-16" />
                    <div className="h-2 bg-zinc-700/30 rounded w-24" />
                    <div className="h-2 bg-zinc-700/50 rounded w-12" />
                    <div className="h-2 bg-orange-500/40 rounded w-20" />
                    <div className="h-2 bg-zinc-700/30 rounded w-16" />
                    <div className="h-2 bg-zinc-700/50 rounded w-28" />
                    <div className="h-2 bg-orange-500/40 rounded w-8" />
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <div className="h-2 bg-zinc-700/30 rounded w-20" />
                    <div className="h-2 bg-zinc-700/50 rounded w-8" />
                    <div className="h-2 bg-zinc-700/30 rounded w-28" />
                    <div className="h-2 bg-orange-500/40 rounded w-12" />
                    <div className="h-2 bg-zinc-700/50 rounded w-16" />
                    <div className="h-2 bg-zinc-700/30 rounded w-24" />
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <div className="h-2 bg-zinc-700/50 rounded w-24" />
                    <div className="h-2 bg-zinc-700/30 rounded w-16" />
                    <div className="h-2 bg-orange-500/40 rounded w-20" />
                    <div className="h-2 bg-zinc-700/50 rounded w-8" />
                  </div>
                  <div className="flex gap-2">
                    <div className="h-2 bg-zinc-700/50 rounded w-12" />
                    <div className="h-2 bg-zinc-700/30 rounded w-16" />
                  </div>
                  <div className="h-6" />
                  <div className="flex gap-2 flex-wrap">
                    <div className="h-2 bg-zinc-700/30 rounded w-24" />
                    <div className="h-2 bg-zinc-700/50 rounded w-16" />
                    <div className="h-2 bg-zinc-700/30 rounded w-20" />
                    <div className="h-2 bg-orange-500/40 rounded w-8" />
                    <div className="h-2 bg-zinc-700/50 rounded w-12" />
                    <div className="h-2 bg-zinc-700/30 rounded w-28" />
                    <div className="h-2 bg-orange-500/40 rounded w-16" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 pt-16">
          {/* Initiatives */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg
                className="w-5 h-5 text-zinc-400"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="10" cy="10" r="8" />
                <circle cx="10" cy="10" r="4" />
                <circle cx="10" cy="10" r="1" fill="currentColor" />
              </svg>
              <span className="text-zinc-200 font-medium">Remember</span>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">Closed threads become cited memory.</p>
          </div>

          {/* Cross-team projects */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg
                className="w-5 h-5 text-zinc-400"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="10" cy="10" r="8" />
                <path d="M2 10h16M10 2a15 15 0 010 16M10 2a15 15 0 000 16" />
              </svg>
              <span className="text-zinc-200 font-medium">Recall</span>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">Ask why from GitHub, Slack, Linear, or your IDE.</p>
          </div>

          {/* Milestones */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-4 h-4 rotate-45 bg-zinc-400" />
              <span className="text-zinc-200 font-medium">Improve</span>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">Maintainer feedback reweights the graph.</p>
          </div>

          {/* Progress insights */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-zinc-400" viewBox="0 0 20 20" fill="currentColor">
                <rect x="2" y="10" width="3" height="8" rx="1" />
                <rect x="7" y="6" width="3" height="12" rx="1" />
                <rect x="12" y="8" width="3" height="10" rx="1" />
                <rect x="17" y="4" width="3" height="14" rx="1" />
              </svg>
              <span className="text-zinc-200 font-medium">Forget</span>
            </div>
            <p className="text-zinc-500 text-sm leading-relaxed">Uninstall prunes the tenant. The memory is yours.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
