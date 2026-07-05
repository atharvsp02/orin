"use client"

import type React from "react"
import { motion } from "framer-motion"
import {
  Inbox,
  CircleUser,
  Layers,
  FolderKanban,
  LayoutGrid,
  Users,
  Smartphone,
  Map,
  FileText,
  ChevronDown,
  ChevronRight,
  CirclePower,
  Search,
  Plus,
  Link2,
  MoreHorizontal,
  Sparkles,
  Settings,
  HelpCircle,
} from "lucide-react"

export function DashboardMockup() {
  const containerVariants = {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: 0.3,
        delayChildren: 0.5,
      },
    },
  }

  const panelVariants = {
    hidden: {
      opacity: 0,
      x: 100,
      y: -80,
    },
    visible: {
      opacity: 1,
      x: 0,
      y: 0,
      transition: {
        duration: 1.2,
        ease: [0.22, 1, 0.36, 1],
      },
    },
  }

  return (
    <motion.div
      className="w-full h-full bg-zinc-950 flex overflow-hidden"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Sidebar */}
      <motion.div
        className="w-[220px] h-full bg-zinc-900/80 border-r border-zinc-800/50 flex flex-col shrink-0"
        variants={panelVariants}
      >
        {/* Logo */}
        <div className="p-3 border-b border-zinc-800/50">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <CirclePower className="w-5 h-5 text-white" />
            <span className="text-white font-semibold text-sm">Orin</span>
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 ml-auto" />
          </div>
        </div>

        {/* Search */}
        <div className="p-3">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-zinc-800/50 rounded-md text-zinc-500 text-xs">
            <Search className="w-3.5 h-3.5" />
            <span>Search...</span>
            <span className="ml-auto text-[10px] bg-zinc-700/50 px-1.5 py-0.5 rounded">⌘K</span>
          </div>
        </div>

        {/* Main nav */}
        <div className="px-3 space-y-0.5">
          <NavItem icon={Inbox} label="Catches" badge={3} active />
          <NavItem icon={CircleUser} label="Decisions" />
        </div>

        {/* Workspace section */}
        <div className="mt-5 px-3">
          <div className="px-2 py-1 text-[10px] text-zinc-500 font-medium uppercase tracking-wider flex items-center gap-1">
            Workspace
          </div>
          <div className="space-y-0.5 mt-1">
            <NavItem icon={Layers} label="Repos" hasSubmenu />
            <NavItem icon={FolderKanban} label="Rules" hasSubmenu />
            <NavItem icon={LayoutGrid} label="Knowledge graph" hasSubmenu />
            <NavItem icon={Users} label="Integrations" hasSubmenu />
          </div>
        </div>

        {/* Favorites section */}
        <div className="mt-5 px-3">
          <div className="px-2 py-1 text-[10px] text-zinc-500 font-medium uppercase tracking-wider flex items-center gap-1">
            Favorites
          </div>
          <div className="space-y-0.5 mt-1">
            <NavItem icon={Smartphone} label="acme/api" color="text-blue-400" />
            <NavItem icon={Map} label="acme/web" color="text-orange-400" />
            <NavItem icon={FileText} label="Decision log" color="text-emerald-400" />
          </div>
        </div>

        {/* Teams section */}
        <div className="mt-5 px-3 flex-1">
          <div className="px-2 py-1 text-[10px] text-zinc-500 font-medium uppercase tracking-wider flex items-center gap-1">
            Your Teams
          </div>
          <div className="space-y-0.5 mt-1">
            <NavItem icon={Sparkles} label="Slack workspace" hasSubmenu />
            <NavItem icon={Settings} label="Linear org" hasSubmenu />
          </div>
        </div>

        {/* Bottom */}
        <div className="p-3 border-t border-zinc-800/50">
          <NavItem icon={HelpCircle} label="Help & Support" />
        </div>
      </motion.div>

      {/* Inbox List */}
      <motion.div
        className="w-[320px] h-full bg-zinc-900/40 border-r border-zinc-800/50 flex flex-col shrink-0"
        variants={panelVariants}
      >
        <div className="px-4 py-3 border-b border-zinc-800/50 flex items-center justify-between">
          <h3 className="text-white font-semibold text-sm">Catches</h3>
          <div className="flex items-center gap-2">
            <button className="text-zinc-500 hover:text-white transition-colors">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto scrollbar-hide">
          <InboxItem
            id="PR-214"
            title="Re-proposes ISSUE-42: Redis cache"
            subtitle="check failed with citation"
            time="2m"
            avatar="https://i.pravatar.cc/32?img=1"
            status="in-progress"
            active
          />
          <InboxItem
            id="ISSUE-42"
            title="Add Redis as caching layer"
            subtitle="recorded as rejected"
            time="1d"
            avatar="https://i.pravatar.cc/32?img=2"
            status="todo"
            isProject
          />
          <InboxItem
            id="PR-198"
            title="Switch API to microservices"
            subtitle="advisory: cites ISSUE-17"
            time="2d"
            avatar="https://i.pravatar.cc/32?img=3"
            status="bug"
          />
          <InboxItem
            id="DOC-7"
            title="Rule: no new runtime deps"
            subtitle="seeded via @orinbot rule"
            time="4h"
            avatar="https://i.pravatar.cc/32?img=4"
            status="todo"
          />
          <InboxItem
            id="OVERRIDE-9"
            title="Adopt Redis for rate limiting"
            subtitle="supersedes ISSUE-42 (scoped)"
            time="1w"
            avatar="https://i.pravatar.cc/32?img=5"
            status="bug"
          />
          <InboxItem
            title="Slack: /why redis rejected?"
            subtitle="answered with evidence"
            avatar="https://i.pravatar.cc/32?img=6"
            status="done"
            isProject
          />
          <InboxItem
            id="PR-201"
            title="Add GraphQL gateway"
            subtitle="maya rated: good catch"
            time="1w"
            avatar="https://i.pravatar.cc/32?img=7"
            status="done"
          />
          <InboxItem
            title="Linear: ORB-33 flagged"
            subtitle="agent replied in session"
            avatar="https://i.pravatar.cc/32?img=8"
            status="todo"
            isProject
          />
        </div>
      </motion.div>

      {/* Detail Panel */}
      <motion.div className="flex-1 h-full bg-zinc-950 flex flex-col overflow-hidden" variants={panelVariants}>
        {/* Header breadcrumb */}
        <div className="px-5 py-3 border-b border-zinc-800/50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-zinc-500">acme/api</span>
            <span className="text-zinc-600">›</span>
            <span className="text-emerald-400">Decision memory</span>
            <span className="text-zinc-600">›</span>
            <span className="text-zinc-300">PR-214</span>
          </div>
          <MoreHorizontal className="w-4 h-4 text-zinc-500" />
        </div>

        {/* Content */}
        <div className="flex-1 p-5 overflow-auto scrollbar-hide">
          <h2 className="text-white text-xl font-semibold mb-5">Add Redis caching layer</h2>

          {/* Code block */}
          <div className="bg-zinc-900/80 rounded-lg p-4 text-[11px] font-mono mb-5 border border-zinc-800/50">
            <div className="space-y-2">
              <div>
                <span className="text-zinc-500">Orin.</span>
                <span className="text-amber-300">check_rejected</span>
                <span className="text-zinc-400"> flagged this pull request as a </span>
                <span className="text-cyan-300">re-proposal</span>
                <span className="text-zinc-400"> of a decision.</span>
              </div>
              <div className="mt-3 text-zinc-600">
                {/* The document content that this comment is associated with. */}
              </div>
              <div>
                <span className="text-purple-400">@decision</span>
                <span className="text-zinc-400">(</span>
                <span className="text-cyan-300">ISSUE-42</span>
                <span className="text-zinc-400">,</span>
                <span className="text-amber-300">outcome</span>
                <span className="text-zinc-400">:</span>
                <span className="text-orange-300">rejected</span>
                <span className="text-zinc-400">,</span>
                <span className="text-amber-300">superseded</span>
                <span className="text-zinc-400">:</span>
                <span className="text-orange-300">false</span>
                <span className="text-zinc-400">)</span>
              </div>
              <div>
                <span className="text-blue-400">reason </span>
                <span className="text-amber-300">ops_burden</span>
                <span className="text-zinc-400">: </span>
                <span className="text-cyan-300">postgres_views_cover_caching</span>
                <span className="text-zinc-400">;</span>
              </div>
              <div className="mt-3 text-zinc-400">
                Evidence:
                <span className="text-emerald-400"> chunk 1 of ISSUE-42</span>
                , recorded Feb 2026, cited in 3 catches so far.
              </div>
            </div>
          </div>

          {/* Meta actions */}
          <div className="space-y-2 text-sm mb-5">
            <div className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors">
              <Plus className="w-4 h-4" />
              <span>View cited decision</span>
            </div>
            <div className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors">
              <Link2 className="w-4 h-4" />
              <span>Override with receipts</span>
            </div>
          </div>

          {/* PR reference */}
          <div className="text-xs text-zinc-500 mb-5">
            <span className="text-zinc-600">ISSUE-42</span>
            <span> rejected Feb 2026: extra service to operate, views cover caching</span>
          </div>

          {/* Activity */}
          <div className="pt-4 border-t border-zinc-800/50">
            <div className="text-xs text-zinc-500 font-medium mb-3 uppercase tracking-wider">Activity</div>
            <div className="space-y-3">
              <ActivityItem
                avatar="https://i.pravatar.cc/24?img=1"
                name="orin"
                action="flagged"
                from="re-proposal"
                to="ISSUE-42"
                time="2 minutes ago"
              />
              <ActivityItem
                avatar="https://i.pravatar.cc/24?img=2"
                name="maya"
                action="replied"
                from="@orinbot good"
                time="1 minute ago"
              />
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

function NavItem({
  icon: Icon,
  label,
  badge,
  active,
  hasSubmenu,
  color,
}: {
  icon: React.ElementType
  label: string
  badge?: number
  active?: boolean
  hasSubmenu?: boolean
  color?: string
}) {
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
        active ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300"
      }`}
    >
      <Icon className={`w-4 h-4 ${color || ""}`} />
      <span className="flex-1 text-xs">{label}</span>
      {badge && (
        <span className="bg-indigo-500/80 text-white text-[10px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full font-medium px-1">
          {badge}
        </span>
      )}
      {hasSubmenu && <ChevronRight className="w-3 h-3 text-zinc-600" />}
    </div>
  )
}

function InboxItem({
  id,
  title,
  subtitle,
  time,
  avatar,
  status,
  isProject,
  active,
}: {
  id?: string
  title: string
  subtitle?: string
  time?: string
  avatar: string
  status: string
  isProject?: boolean
  active?: boolean
}) {
  const statusColors: Record<string, string> = {
    "in-progress": "bg-yellow-500",
    todo: "bg-zinc-600",
    bug: "bg-red-500",
    done: "bg-emerald-500",
  }

  return (
    <div
      className={`px-4 py-3 border-b border-zinc-800/30 cursor-pointer transition-colors ${
        active ? "bg-zinc-800/50" : "hover:bg-zinc-800/30"
      }`}
    >
      <div className="flex items-start gap-3">
        <img src={avatar || "/placeholder.svg"} alt="" className="w-8 h-8 rounded-full shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            {id && <span className="text-zinc-500 text-[10px]">{id}</span>}
            {isProject && <span className="text-violet-400 text-[10px]">Project</span>}
            <div className={`w-2 h-2 rounded-full ${statusColors[status] || "bg-zinc-500"}`} />
          </div>
          <p className="text-white text-xs truncate leading-tight">{title}</p>
          {subtitle && <p className="text-zinc-500 text-[10px] mt-0.5 truncate">{subtitle}</p>}
        </div>
        {time && <span className="text-zinc-600 text-[10px] shrink-0">{time}</span>}
      </div>
    </div>
  )
}

function ActivityItem({
  avatar,
  name,
  action,
  from,
  to,
  time,
}: {
  avatar: string
  name: string
  action: string
  from: string
  to?: string
  time: string
}) {
  return (
    <div className="flex items-start gap-2">
      <img src={avatar || "/placeholder.svg"} alt="" className="w-5 h-5 rounded-full" />
      <div className="flex-1">
        <p className="text-zinc-400 text-xs">
          <span className="text-white">{name}</span>
          <span className="text-zinc-500"> {action} </span>
          <span className="text-zinc-300">{from}</span>
          {to && (
            <>
              <span className="text-zinc-500"> to </span>
              <span className="text-zinc-300">{to}</span>
            </>
          )}
        </p>
        <p className="text-zinc-600 text-[10px] mt-0.5">{time}</p>
      </div>
    </div>
  )
}
