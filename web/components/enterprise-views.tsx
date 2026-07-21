"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  SiBox,
  SiConfluence,
  SiDropbox,
  SiGithub,
  SiGoogledrive,
  SiJira,
  SiLinear,
  SiNotion,
} from "@icons-pack/react-simple-icons"
import { FaMicrosoft, FaSlack } from "react-icons/fa"
import { TbBrandOnedrive } from "react-icons/tb"
import {
  Bot,
  Check,
  ChevronRight,
  ExternalLink,
  FileSearch,
  LoaderCircle,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
} from "lucide-react"
import {
  api,
  timeAgo,
  type AuditEvent,
  type ChatThread,
  type PermissionGrant,
  type SearchResult,
  type WorkspaceGroup,
  type WorkspaceMember,
  type WorkspacePermission,
  type WorkspaceRole,
} from "@/lib/orin-api"

const card = "rounded-xl border border-zinc-800 bg-zinc-900/50"

export function ConnectorLogo({ provider, className = "w-5 h-5" }: { provider: string; className?: string }) {
  const icons: Record<string, React.ElementType> = {
    github: SiGithub,
    slack: FaSlack,
    linear: SiLinear,
    gdrive: SiGoogledrive,
    googledrive: SiGoogledrive,
    onedrive: TbBrandOnedrive,
    sharepoint: FaMicrosoft,
    confluence: SiConfluence,
    notion: SiNotion,
    jira: SiJira,
    dropbox: SiDropbox,
    box: SiBox,
  }
  const Icon = icons[provider.toLowerCase()] ?? FileSearch
  return <Icon className={className} aria-hidden="true" />
}

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex-1 h-full bg-zinc-950 overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-10">
        <div className="flex items-start justify-between gap-6 mb-8">
          <div>
            <h2 className="text-white text-xl font-medium tracking-tight">{title}</h2>
            <p className="text-zinc-500 text-xs mt-1.5 max-w-xl leading-relaxed">{subtitle}</p>
          </div>
          {action}
        </div>
        {children}
      </div>
    </div>
  )
}

function ErrorText({ value }: { value: string }) {
  return <div className="rounded-lg border border-red-900/50 bg-red-950/20 px-4 py-3 text-red-300 text-xs">{value}</div>
}

export function SearchView({ workspaceId }: { workspaceId: string }) {
  const [query, setQuery] = useState("")
  const [provider, setProvider] = useState("")
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const submit = async () => {
    const value = query.trim()
    if (!value) return
    setBusy(true)
    setError("")
    try {
      setResults((await api.search(workspaceId, value, provider || undefined)).results)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Search" subtitle="Search every connected source. Results, counts, snippets, and links are filtered through your current source permissions.">
      <div className={`${card} p-4 mb-5`}>
        <div className="flex gap-2">
          <div className="flex-1 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3">
            <Search className="w-4 h-4 text-zinc-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void submit()}
              placeholder="Search decisions, documents, messages, and issues"
              className="h-10 flex-1 bg-transparent text-zinc-200 text-sm outline-none placeholder:text-zinc-600"
            />
          </div>
          <select value={provider} onChange={(event) => setProvider(event.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-zinc-300 text-xs">
            <option value="">All sources</option>
            <option value="gdrive">Google Drive</option>
            <option value="github">GitHub</option>
            <option value="slack">Slack</option>
            <option value="linear">Linear</option>
          </select>
          <button onClick={submit} disabled={busy || !query.trim()} className="rounded-lg bg-white px-5 text-zinc-950 text-xs font-medium disabled:opacity-40">
            {busy ? "Searching" : "Search"}
          </button>
        </div>
      </div>
      {error && <ErrorText value={error} />}
      {results?.length === 0 && <div className={`${card} p-10 text-center text-zinc-500 text-sm`}>No matching content is available to you.</div>}
      <div className="space-y-3">
        {results?.map((result) => (
          <div key={result.itemId} className={`${card} p-5`}>
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-200 shrink-0">
                <ConnectorLogo provider={result.provider} className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-zinc-100 text-sm font-medium">{result.title}</h3>
                  <span className="text-[0.625rem] uppercase tracking-wide text-zinc-600">{result.provider}</span>
                </div>
                <p className="text-zinc-400 text-xs leading-relaxed mt-2">{result.snippet}</p>
                <div className="flex items-center gap-3 mt-3 text-[0.625rem] text-zinc-600">
                  <span>{result.sourceType}</span>
                  {result.sourceUpdatedAt && <span>updated {timeAgo(result.sourceUpdatedAt)}</span>}
                  {result.url && (
                    <a href={result.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-zinc-400 hover:text-white">
                      Open source <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

interface ChatLine {
  role: "user" | "assistant"
  content: string
  citations: SearchResult[]
}

export function AskView({ workspaceId }: { workspaceId: string }) {
  const [question, setQuestion] = useState("")
  const [threadId, setThreadId] = useState<string>()
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [lines, setLines] = useState<ChatLine[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const refreshThreads = useCallback(async () => {
    setThreads((await api.chatThreads(workspaceId)).threads)
  }, [workspaceId])

  useEffect(() => {
    void refreshThreads().catch((cause) => setError((cause as Error).message))
  }, [refreshThreads])

  const openThread = async (nextThreadId: string) => {
    if (!nextThreadId) {
      setThreadId(undefined)
      setLines([])
      setError("")
      return
    }
    setBusy(true)
    setError("")
    try {
      const response = await api.chatMessages(workspaceId, nextThreadId)
      setThreadId(nextThreadId)
      setLines(response.messages.map((message) => ({ role: message.role, content: message.content, citations: message.citations })))
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    const value = question.trim()
    if (!value) return
    setLines((current) => [...current, { role: "user", content: value, citations: [] }])
    setQuestion("")
    setBusy(true)
    setError("")
    try {
      const response = await api.ask(workspaceId, value, threadId)
      setThreadId(response.threadId)
      setLines((current) => [...current, { role: "assistant", content: response.answer, citations: response.citations }])
      await refreshThreads()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="Ask Orin"
      subtitle="Ask across connected sources. Only evidence you can currently access is sent to the answer model, and every factual answer includes source links."
      action={threads.length > 0 ? (
        <select value={threadId ?? ""} onChange={(event) => void openThread(event.target.value)} aria-label="Recent conversations" className="h-9 max-w-64 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-zinc-300 text-xs">
          <option value="">New conversation</option>
          {threads.map((thread) => <option key={thread.threadId} value={thread.threadId}>{thread.title}</option>)}
        </select>
      ) : undefined}
    >
      <div className="space-y-4 mb-5">
        {lines.length === 0 && (
          <div className={`${card} p-10 text-center`}>
            <Bot className="w-7 h-7 text-zinc-500 mx-auto mb-3" />
            <p className="text-zinc-300 text-sm">Ask about a decision, plan, owner, document, or discussion.</p>
            <p className="text-zinc-600 text-xs mt-1">Orin answers only when your authorized sources contain enough evidence.</p>
          </div>
        )}
        {lines.map((line, index) => (
          <div key={`${line.role}-${index}`} className={line.role === "user" ? "ml-16" : "mr-16"}>
            <div className={`${card} p-4 ${line.role === "user" ? "bg-zinc-800/70" : ""}`}>
              <div className="text-[0.625rem] uppercase tracking-wide text-zinc-600 mb-2">{line.role === "user" ? "You" : "Orin"}</div>
              <p className="text-zinc-200 text-sm leading-relaxed whitespace-pre-wrap">{line.content}</p>
              {line.citations.length > 0 && (
                <div className="mt-4 pt-3 border-t border-zinc-800 space-y-2">
                  {line.citations.map((citation, citationIndex) => (
                    <a key={citation.itemId} href={citation.url || undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs text-zinc-400 hover:text-white">
                      <span className="w-5 h-5 rounded bg-zinc-800 flex items-center justify-center text-[0.625rem]">{citationIndex + 1}</span>
                      <ConnectorLogo provider={citation.provider} className="w-3.5 h-3.5" />
                      <span className="truncate">{citation.title}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-zinc-500 text-xs"><LoaderCircle className="w-4 h-4 animate-spin" /> Building a permission-aware answer</div>}
        {error && <ErrorText value={error} />}
      </div>
      <div className={`${card} p-3 flex gap-2 sticky bottom-0`}>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder="Why did we choose this approach?"
          className="min-h-16 flex-1 resize-none bg-transparent p-2 text-zinc-200 text-sm outline-none placeholder:text-zinc-600"
        />
        <button onClick={submit} disabled={busy || !question.trim()} className="self-end rounded-lg bg-white px-5 py-2.5 text-zinc-950 text-xs font-medium disabled:opacity-40">Ask</button>
      </div>
    </Panel>
  )
}

const roles: WorkspaceRole[] = ["owner", "admin", "member", "viewer"]

export function PeopleView({ workspaceId, currentUserId }: { workspaceId: string; currentUserId: string }) {
  const [people, setPeople] = useState<WorkspaceMember[]>([])
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState<WorkspaceRole>("member")
  const [error, setError] = useState("")
  const refresh = useCallback(() => api.people(workspaceId).then((value) => setPeople(value.people)), [workspaceId])
  useEffect(() => { void refresh().catch((cause) => setError((cause as Error).message)) }, [refresh])

  const invite = async () => {
    setError("")
    try {
      await api.invitePerson(workspaceId, email, name, role)
      setEmail("")
      setName("")
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  const update = async (userId: string, patch: { role?: WorkspaceRole; status?: "active" | "suspended" }) => {
    setError("")
    try {
      await api.updatePerson(workspaceId, userId, patch)
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  return (
    <Panel title="People" subtitle="Control who belongs to this workspace and the role that defines their default product access.">
      <div className={`${card} p-4 mb-5`}>
        <div className="flex gap-2">
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" className="h-9 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-zinc-200 text-xs outline-none" />
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" className="h-9 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-zinc-200 text-xs outline-none" />
          <select value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-zinc-300 text-xs">
            {roles.map((value) => <option key={value}>{value}</option>)}
          </select>
          <button onClick={invite} disabled={!email.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 text-zinc-950 text-xs font-medium disabled:opacity-40"><UserPlus className="w-3.5 h-3.5" /> Add member</button>
        </div>
        {error && <div className="mt-3"><ErrorText value={error} /></div>}
      </div>
      <div className={`${card} divide-y divide-zinc-800`}>
        {people.map((person) => (
          <div key={person.userId} className="flex items-center gap-4 px-5 py-4">
            <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 text-xs">{(person.displayName || person.primaryEmail || "U").slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <div className="text-zinc-200 text-xs font-medium">{person.displayName || person.primaryEmail}</div>
              <div className="text-zinc-600 text-[0.625rem] mt-1">{person.primaryEmail || "No email"}{person.userId === currentUserId ? " · you" : ""}</div>
            </div>
            <select aria-label={`Role for ${person.displayName || person.primaryEmail || person.userId}`} value={person.role} onChange={(event) => void update(person.userId, { role: event.target.value as WorkspaceRole })} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-300 text-xs">
              {roles.map((value) => <option key={value}>{value}</option>)}
            </select>
            <button onClick={() => void update(person.userId, { status: person.status === "active" ? "suspended" : "active" })} className={`rounded-lg border px-3 py-1.5 text-xs ${person.status === "active" ? "border-zinc-700 text-zinc-400" : "border-amber-800 text-amber-300"}`}>
              {person.status === "active" ? "Suspend" : "Restore"}
            </button>
          </div>
        ))}
      </div>
    </Panel>
  )
}

export function GroupsView({ workspaceId }: { workspaceId: string }) {
  const [groups, setGroups] = useState<WorkspaceGroup[]>([])
  const [people, setPeople] = useState<WorkspaceMember[]>([])
  const [name, setName] = useState("")
  const [externalId, setExternalId] = useState("")
  const [drafts, setDrafts] = useState<Record<string, string[]>>({})
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    const [groupData, peopleData] = await Promise.all([api.groups(workspaceId), api.people(workspaceId)])
    setGroups(groupData.groups)
    setPeople(peopleData.people.filter((person) => person.status === "active"))
    setDrafts(Object.fromEntries(groupData.groups.map((group) => [group.groupId, group.memberIds])))
  }, [workspaceId])
  useEffect(() => { void refresh().catch((cause) => setError((cause as Error).message)) }, [refresh])

  const create = async () => {
    setError("")
    try {
      await api.createGroup(workspaceId, name, externalId || undefined)
      setName("")
      setExternalId("")
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  const updateMembers = async (groupId: string) => {
    setError("")
    try {
      await api.setGroupMembers(workspaceId, groupId, drafts[groupId] ?? [])
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  const remove = async (groupId: string) => {
    setError("")
    try {
      await api.deleteGroup(workspaceId, groupId)
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  return (
    <Panel title="Groups" subtitle="Use groups for controlled feature rollout and to map external source groups. Group grants never override source document permissions.">
      <div className={`${card} p-4 mb-5 flex gap-2`}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Group name" className="h-9 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-zinc-200 text-xs outline-none" />
        <input value={externalId} onChange={(event) => setExternalId(event.target.value)} placeholder="External group email or ID, optional" className="h-9 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-zinc-200 text-xs outline-none" />
        <button onClick={create} disabled={!name.trim()} className="rounded-lg bg-white px-4 text-zinc-950 text-xs font-medium disabled:opacity-40">Create group</button>
      </div>
      {error && <div className="mb-4"><ErrorText value={error} /></div>}
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.groupId} className={`${card} p-5`}>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div><div className="text-zinc-200 text-sm font-medium">{group.displayName}</div><div className="text-zinc-600 text-[0.625rem] mt-1">{group.externalId || "Orin-managed group"}</div></div>
              <button onClick={() => void remove(group.groupId)} aria-label={`Delete ${group.displayName}`} className="text-zinc-600 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {people.map((person) => {
                const selected = (drafts[group.groupId] ?? []).includes(person.userId)
                return (
                  <label key={person.userId} className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-zinc-400 text-xs cursor-pointer">
                    <input type="checkbox" checked={selected} onChange={() => setDrafts((current) => ({
                      ...current,
                      [group.groupId]: selected
                        ? (current[group.groupId] ?? []).filter((id) => id !== person.userId)
                        : [...(current[group.groupId] ?? []), person.userId],
                    }))} />
                    {person.displayName || person.primaryEmail}
                  </label>
                )
              })}
            </div>
            <button onClick={() => void updateMembers(group.groupId)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-300 text-xs">Save members</button>
          </div>
        ))}
      </div>
    </Panel>
  )
}

const permissions: WorkspacePermission[] = [
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

export function AccessView({ workspaceId }: { workspaceId: string }) {
  const [grants, setGrants] = useState<PermissionGrant[]>([])
  const [people, setPeople] = useState<WorkspaceMember[]>([])
  const [groups, setGroups] = useState<WorkspaceGroup[]>([])
  const [principalType, setPrincipalType] = useState<"role" | "user" | "group">("role")
  const [principalId, setPrincipalId] = useState("member")
  const [permission, setPermission] = useState<WorkspacePermission>("chat.use")
  const [effect, setEffect] = useState<"allow" | "deny">("allow")
  const [conditionKey, setConditionKey] = useState("")
  const [conditionValue, setConditionValue] = useState("")
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    const [grantData, peopleData, groupData] = await Promise.all([api.permissionGrants(workspaceId), api.people(workspaceId), api.groups(workspaceId)])
    setGrants(grantData.grants)
    setPeople(peopleData.people)
    setGroups(groupData.groups)
  }, [workspaceId])
  useEffect(() => { void refresh().catch((cause) => setError((cause as Error).message)) }, [refresh])

  const options = useMemo(() => {
    if (principalType === "role") return roles.map((value) => ({ id: value, label: value }))
    if (principalType === "user") return people.map((person) => ({ id: person.userId, label: person.displayName || person.primaryEmail || person.userId }))
    return groups.map((group) => ({ id: group.groupId, label: group.displayName }))
  }, [groups, people, principalType])
  useEffect(() => {
    if (!options.some((option) => option.id === principalId)) setPrincipalId(options[0]?.id ?? "")
  }, [options, principalId])

  const create = async () => {
    setError("")
    try {
      await api.createPermissionGrant(workspaceId, {
        principalType,
        principalId,
        permission,
        effect,
        conditions: conditionKey && conditionValue ? { [conditionKey]: conditionValue } : {},
      })
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  const remove = async (grantId: string) => {
    setError("")
    try {
      await api.deletePermissionGrant(workspaceId, grantId)
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  return (
    <Panel title="Feature access" subtitle="Add role, user, or group grants. Deny wins over allow. Conditions can limit a grant to a connector provider, resource, or source type.">
      <div className={`${card} p-4 mb-5 grid grid-cols-2 md:grid-cols-6 gap-2`}>
        <select value={principalType} onChange={(event) => setPrincipalType(event.target.value as typeof principalType)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-zinc-300 text-xs h-9"><option value="role">Role</option><option value="user">User</option><option value="group">Group</option></select>
        <select value={principalId} onChange={(event) => setPrincipalId(event.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-zinc-300 text-xs h-9">{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        <select value={permission} onChange={(event) => setPermission(event.target.value as WorkspacePermission)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-zinc-300 text-xs h-9">{permissions.map((value) => <option key={value}>{value}</option>)}</select>
        <select value={effect} onChange={(event) => setEffect(event.target.value as typeof effect)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-zinc-300 text-xs h-9"><option value="allow">Allow</option><option value="deny">Deny</option></select>
        <select value={conditionKey} onChange={(event) => setConditionKey(event.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-zinc-300 text-xs h-9"><option value="">No condition</option><option value="connectorProvider">Provider</option><option value="resourceId">Resource</option><option value="sourceType">Source type</option></select>
        <input value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} disabled={!conditionKey} placeholder="Condition value" className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-zinc-300 text-xs h-9 disabled:opacity-40" />
        <button onClick={create} disabled={!principalId} className="rounded-lg bg-white px-4 text-zinc-950 text-xs font-medium h-9">Add grant</button>
      </div>
      {error && <div className="mb-4"><ErrorText value={error} /></div>}
      <div className={`${card} divide-y divide-zinc-800`}>
        {grants.map((grant) => (
          <div key={grant.grantId} className="flex items-center gap-3 px-5 py-4 text-xs">
            <ShieldCheck className={`w-4 h-4 ${grant.effect === "allow" ? "text-emerald-400" : "text-red-400"}`} />
            <span className="text-zinc-300">{grant.principalType}:{grant.principalId}</span>
            <ChevronRight className="w-3 h-3 text-zinc-700" />
            <span className="text-zinc-200">{grant.effect} {grant.permission}</span>
            {Object.keys(grant.conditions).length > 0 && <span className="text-zinc-600">when {JSON.stringify(grant.conditions)}</span>}
            <button onClick={() => void remove(grant.grantId)} aria-label={`Delete ${grant.permission} grant`} className="ml-auto text-zinc-600 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
      </div>
    </Panel>
  )
}

export function AuditView({ workspaceId }: { workspaceId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    try {
      setEvents((await api.auditEvents(workspaceId)).events)
      setError("")
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [workspaceId])
  useEffect(() => { void refresh() }, [refresh])

  return (
    <Panel title="Audit log" subtitle="Review access denials, searches, chats, connector syncs, role changes, group changes, and policy changes." action={<button onClick={refresh} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-300 text-xs">Refresh</button>}>
      {error && <ErrorText value={error} />}
      <div className={`${card} divide-y divide-zinc-800`}>
        {events.map((event) => (
          <div key={event.eventId} className="px-5 py-4 flex items-start gap-3">
            <div className={`mt-1 w-2 h-2 rounded-full ${event.outcome === "success" ? "bg-emerald-500" : event.outcome === "denied" ? "bg-amber-500" : "bg-red-500"}`} />
            <div className="min-w-0 flex-1"><div className="text-zinc-200 text-xs font-medium">{event.action}</div><div className="text-zinc-600 text-[0.625rem] mt-1 truncate">{event.targetType}:{event.targetId} · actor {event.actorUserId || "system"}</div></div>
            <span className="text-zinc-600 text-[0.625rem]">{timeAgo(event.createdAt)}</span>
          </div>
        ))}
        {events.length === 0 && <div className="p-10 text-center text-zinc-600 text-xs">No audit events yet.</div>}
      </div>
    </Panel>
  )
}

export function PermissionBadge({ permission, allowed }: { permission: string; allowed: boolean }) {
  return <span className={`inline-flex items-center gap-1 text-[0.625rem] ${allowed ? "text-emerald-400" : "text-zinc-600"}`}>{allowed && <Check className="w-3 h-3" />}{permission}</span>
}
