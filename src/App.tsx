import { useEffect, useState } from 'react'

type TaskState = 'draft' | 'queued' | 'running' | 'review' | 'approved' | 'applied' | 'failed' | 'cancelled'

type Runner = {
  id: string
  name: string
  endpoint?: string
  os: string
  status: string
  tools: string[]
  projects: string[]
  capabilities?: string[]
}

type Project = {
  id: string
  name: string
  absolutePath: string
  allowedCommands: string[]
  defaultCommand: string
}

type TaskResult = {
  ok: boolean
  command?: string
  durationMs?: number
  summary: string
  diff?: string[]
  gitStatus?: string
  gitAvailable?: boolean
  worktreePath?: string
  worktreeBranch?: string
  agentGitStatus?: string
  applied?: boolean
  appliedAt?: string
  changedFiles?: string[]
  changeStat?: string
}

type TaskEvent = {
  type: 'log' | 'state'
  level?: 'info' | 'stdout' | 'stderr' | 'error'
  message?: string
  status?: TaskState
  result?: TaskResult | null
}

type TaskRecord = {
  id: string
  runnerId?: string
  runnerName?: string
  description: string
  tool: string
  priority?: string
  status: TaskState
  createdAt: string
  retryOf?: string | null
  result: TaskResult | null
  routing?: {
    mode: string
    selectedRunnerName: string
    reason: string
  } | null
}

type TaskDetail = TaskRecord & {
  events?: TaskEvent[]
}

const apiBase = import.meta.env.DEV ? 'http://localhost:8787' : ''
const defaultRelayUrl = 'http://localhost:8790'

const fallbackRunners: Runner[] = [
  {
    name: 'Local OmniFleet Runner',
    id: 'local-runner-01',
    os: 'Windows',
    status: 'offline demo',
    tools: ['mock-agent'],
    projects: ['OmniFleet'],
    capabilities: ['stream_logs', 'collect_result'],
  },
]

const fallbackProjects: Project[] = [
  {
    id: 'omnifleet',
    name: 'OmniFleet',
    absolutePath: '.',
    allowedCommands: ['npm run build'],
    defaultCommand: 'npm run build',
  },
]

const offlineTimeline = [
  'offline demo task accepted',
  'project context loaded: OmniFleet',
  'policy check: edit_code allowed, push denied',
  'mock-agent adapter started',
  'simulated safe command completed',
  'diff ready for human review',
]

export function App() {
  const [task, setTask] = useState('Build this project through the local runner, stream logs, and wait for approval.')
  const [runners, setRunners] = useState<Runner[]>(fallbackRunners)
  const [projects, setProjects] = useState<Project[]>(fallbackProjects)
  const [selectedRunner, setSelectedRunner] = useState(fallbackRunners[0].id)
  const [selectedProject, setSelectedProject] = useState(fallbackProjects[0].id)
  const [selectedTool, setSelectedTool] = useState('mock-agent')
  const [taskPriority, setTaskPriority] = useState('normal')
  const [batchMode, setBatchMode] = useState(false)
  const [state, setState] = useState<TaskState>('draft')
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [result, setResult] = useState<TaskResult | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskDetail | null>(null)
  const [runnerOnline, setRunnerOnline] = useState(false)
  const [runnerUptime, setRunnerUptime] = useState<string | null>(null)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [runnerStats, setRunnerStats] = useState<Record<string, unknown> | null>(null)
  const [relayStatsData, setRelayStatsData] = useState<Record<string, unknown> | null>(null)
  const [logContent, setLogContent] = useState<string | null>(null)
  const [logStatus, setLogStatus] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [history, setHistory] = useState<TaskRecord[]>([])
  const [lastHistoryRefresh, setLastHistoryRefresh] = useState<string | null>(null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyStatus, setHistoryStatus] = useState<TaskState | 'all'>('all')
  const [token, setToken] = useState(() => localStorage.getItem('omnifleet-token') ?? '')
  const [authError, setAuthError] = useState<string | null>(null)
  const [relayUrl, setRelayUrl] = useState(() => localStorage.getItem('omnifleet-relay-url') ?? defaultRelayUrl)
  const [relayToken, setRelayToken] = useState(() => localStorage.getItem('omnifleet-relay-token') ?? '')
  const [relayStatus, setRelayStatus] = useState<string | null>(null)
  const [useRelayProxy, setUseRelayProxy] = useState(false)
  const [autoRoute, setAutoRoute] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectPath, setNewProjectPath] = useState('')
  const [newProjectCommands, setNewProjectCommands] = useState('npm run build')
  const [newProjectDefaultCommand, setNewProjectDefaultCommand] = useState('npm run build')
  const [projectStatus, setProjectStatus] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<{ taskId: string; path: string; taskStatus: string }[]>([])
  const [worktreeStatus, setWorktreeStatus] = useState<string | null>(null)

  useEffect(() => {
    async function loadRunner() {
      try {
        const [runnerResponse, projectResponse] = await Promise.all([
          apiFetch('/api/runners'),
          apiFetch('/api/projects'),
        ])
        if (!runnerResponse.ok || !projectResponse.ok) throw new Error('runner unavailable')

        const nextRunners = (await runnerResponse.json()) as Runner[]
        const nextProjects = (await projectResponse.json()) as Project[]
        setRunners(nextRunners)
        setProjects(nextProjects)
        setSelectedRunner(nextRunners[0]?.id ?? fallbackRunners[0].id)
        setSelectedProject(nextProjects[0]?.id ?? fallbackProjects[0].id)
        setSelectedTool(nextRunners[0]?.tools[0] ?? 'mock-agent')
        setRunnerOnline(true)
        setAuthError(null)
        loadHistory()
        fetchHealth()
      } catch (error) {
        setRunnerOnline(false)
        setAuthError(error instanceof Error ? error.message : 'runner unavailable')
      }
    }

    loadRunner()
  }, [token])

  useEffect(() => {
    if (!runnerOnline) return

    const interval = window.setInterval(() => loadHistory(), 15000)
    return () => window.clearInterval(interval)
  }, [runnerOnline])

  const currentRunner = runners.find((runner) => runner.id === selectedRunner) ?? runners[0]
  const currentProject = projects.find((project) => project.id === selectedProject) ?? projects[0]
  const runnerBase = currentRunner.endpoint ?? apiBase
  const relayBase = relayUrl.replace(/\/$/, '')
  const logEvents = events.filter((event) => event.type === 'log')
  const diffLines = result?.diff ?? []
  const filteredHistory = history.filter((item) => {
    const query = historyQuery.trim().toLowerCase()
    const matchesQuery = !query || [item.id, item.description, item.tool, item.runnerName, item.runnerId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query))
    const matchesStatus = historyStatus === 'all' || item.status === historyStatus
    return matchesQuery && matchesStatus
  })
  const historyCounts = history.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1
    counts.total = (counts.total ?? 0) + 1
    return counts
  }, { total: 0 })

  function taskPath(path: 'events' | 'approve' | 'apply' | 'cancel' | 'retry', id: string, runnerId = selectedRunner) {
    if (useRelayProxy) return `/api/tasks/${runnerId}/${id}/${path}`
    return `/api/tasks/${id}/${path}`
  }

  function apiFetch(path: string, options: RequestInit = {}) {
    const base = useRelayProxy ? relayBase : runnerBase
    return fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(useRelayProxy && relayToken ? { 'X-OmniFleet-Relay-Token': relayToken } : {}),
        ...(token ? { 'X-OmniFleet-Token': token } : {}),
      },
    }).then((response) => {
      if (response.status === 401) throw new Error('runner token required')
      return response
    })
  }

  function saveToken() {
    localStorage.setItem('omnifleet-token', token)
    setAuthError(null)
  }

  function saveRelayToken() {
    localStorage.setItem('omnifleet-relay-token', relayToken)
    setRelayStatus(null)
  }

  function parseCommandList(value: string) {
    return value.split(',').map((command) => command.trim()).filter(Boolean)
  }

  async function loadProjectsForRunner(runner: Runner) {
    try {
      const endpoint = runner.endpoint ?? apiBase
      const response = await fetch(`${endpoint}/api/projects`, {
        headers: token ? { 'X-OmniFleet-Token': token } : {},
      })
      if (!response.ok) throw new Error('runner projects unavailable')
      const nextProjects = (await response.json()) as Project[]
      setProjects(nextProjects)
      setSelectedProject(nextProjects[0]?.id ?? fallbackProjects[0].id)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'runner projects unavailable')
    }
  }

  function selectRunner(runnerId: string) {
    setSelectedRunner(runnerId)
    const runner = runners.find((item) => item.id === runnerId)
    if (runner) {
      setSelectedTool(runner.tools[0] ?? 'mock-agent')
      loadProjectsForRunner(runner)
    }
  }

  async function loadRelayRunners() {
    try {
      localStorage.setItem('omnifleet-relay-url', relayUrl)
      const response = await fetch(`${relayBase}/api/runners`, {
        headers: relayToken ? { 'X-OmniFleet-Relay-Token': relayToken } : {},
      })
      if (!response.ok) throw new Error('relay unavailable')
      const relayRunners = (await response.json()) as Runner[]
      if (relayRunners.length === 0) {
        setRelayStatus('relay connected, no runners registered')
        return
      }

      setRunners(relayRunners)
      setSelectedRunner(relayRunners[0].id)
      setSelectedTool(relayRunners[0].tools[0] ?? 'mock-agent')
      loadProjectsForRunner(relayRunners[0])
      setUseRelayProxy(true)
      setRelayStatus(`loaded ${relayRunners.length} runner(s) from relay`)
    } catch (error) {
      setRelayStatus(error instanceof Error ? error.message : 'relay unavailable')
    }
  }

  async function unregisterRunner() {
    if (!useRelayProxy || !selectedRunner) return

    try {
      const response = await fetch(`${relayBase}/api/runners/${selectedRunner}`, {
        method: 'DELETE',
        headers: relayToken ? { 'X-OmniFleet-Relay-Token': relayToken } : {},
      })
      if (!response.ok) throw new Error('failed to unregister runner')
      setRelayStatus(`unregistered runner ${selectedRunner}`)
      loadRelayRunners()
    } catch (error) {
      setRelayStatus(error instanceof Error ? error.message : 'failed to unregister runner')
    }
  }

  async function registerProject() {
    try {
      const endpoint = currentRunner.endpoint ?? apiBase
      const allowedCommands = parseCommandList(newProjectCommands)
      const response = await fetch(`${endpoint}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-OmniFleet-Token': token } : {}),
        },
        body: JSON.stringify({
          name: newProjectName,
          path: newProjectPath,
          allowedCommands,
          defaultCommand: newProjectDefaultCommand || allowedCommands[0],
        }),
      })
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? 'failed to register project')
      }
      const project = (await response.json()) as Project
      setProjectStatus(`registered ${project.name}`)
      setNewProjectName('')
      setNewProjectPath('')
      setNewProjectCommands('npm run build')
      setNewProjectDefaultCommand('npm run build')
      await loadProjectsForRunner(currentRunner)
      if (useRelayProxy) await loadRelayRunners()
    } catch (error) {
      setProjectStatus(error instanceof Error ? error.message : 'failed to register project')
    }
  }

  async function unregisterProject() {
    try {
      const endpoint = currentRunner.endpoint ?? apiBase
      const response = await fetch(`${endpoint}/api/projects/${selectedProject}`, {
        method: 'DELETE',
        headers: token ? { 'X-OmniFleet-Token': token } : {},
      })
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? 'failed to unregister project')
      }
      setProjectStatus(`unregistered ${selectedProject}`)
      await loadProjectsForRunner(currentRunner)
      if (useRelayProxy) await loadRelayRunners()
    } catch (error) {
      setProjectStatus(error instanceof Error ? error.message : 'failed to unregister project')
    }
  }

  async function fetchWorktrees() {
    try {
      const response = await apiFetch('/api/worktrees')
      if (!response.ok) throw new Error('failed to fetch worktrees')
      setWorktrees((await response.json()) as { taskId: string; path: string; taskStatus: string }[])
      setWorktreeStatus(null)
    } catch (error) {
      setWorktreeStatus(error instanceof Error ? error.message : 'failed to fetch worktrees')
    }
  }

  async function cleanupWorktrees() {
    try {
      const response = await apiFetch('/api/worktrees/cleanup', { method: 'POST' })
      if (!response.ok) throw new Error('failed to clean up worktrees')
      const result = (await response.json()) as { cleaned: number }
      setWorktreeStatus(`cleaned ${result.cleaned} worktree(s)`)
      fetchWorktrees()
    } catch (error) {
      setWorktreeStatus(error instanceof Error ? error.message : 'failed to clean up worktrees')
    }
  }

  async function updateProject() {
    try {
      const endpoint = currentRunner.endpoint ?? apiBase
      const name = newProjectName || currentProject.name
      const path = newProjectPath || currentProject.absolutePath
      const allowedCommands = parseCommandList(newProjectCommands || currentProject.allowedCommands.join(', '))
      const command = newProjectDefaultCommand || currentProject.defaultCommand || allowedCommands[0]
      const response = await fetch(`${endpoint}/api/projects/${selectedProject}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-OmniFleet-Token': token } : {}),
        },
        body: JSON.stringify({
          name,
          path,
          allowedCommands,
          defaultCommand: command,
        }),
      })
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? 'failed to update project')
      }
      const project = (await response.json()) as Project
      setProjectStatus(`updated ${project.name}`)
      await loadProjectsForRunner(currentRunner)
      if (useRelayProxy) await loadRelayRunners()
    } catch (error) {
      setProjectStatus(error instanceof Error ? error.message : 'failed to update project')
    }
  }

  async function fetchHealth() {
    try {
      const base = useRelayProxy ? relayBase : runnerBase
      const started = Date.now()
      const [healthRes, statsRes] = await Promise.all([
        fetch(`${base}/api/health`, {
          headers: {
            ...(useRelayProxy && relayToken ? { 'X-OmniFleet-Relay-Token': relayToken } : {}),
            ...(token ? { 'X-OmniFleet-Token': token } : {}),
          },
        }),
        apiFetch('/api/stats'),
      ])
      setLatencyMs(Date.now() - started)
      if (healthRes.ok) {
        const health = (await healthRes.json()) as { runner?: { startedAt?: string; uptimeMs?: number } }
        if (health.runner?.startedAt) {
          setRunnerUptime(new Date(health.runner.startedAt).toLocaleString())
        }
      }
      if (statsRes.ok) {
        setRunnerStats((await statsRes.json()) as Record<string, unknown>)
      }
      if (useRelayProxy && relayToken) {
        const relayStatsRes = await fetch(`${relayBase}/api/stats`, {
          headers: { 'X-OmniFleet-Relay-Token': relayToken },
        })
        if (relayStatsRes.ok) {
          setRelayStatsData((await relayStatsRes.json()) as Record<string, unknown>)
        }
      } else {
        setRelayStatsData(null)
      }
    } catch {
      setRunnerUptime(null)
    }
  }

  async function loadHistory() {
    try {
      const response = await apiFetch('/api/tasks')
      if (!response.ok) return
      setHistory((await response.json()) as TaskRecord[])
      setLastHistoryRefresh(new Date().toLocaleTimeString())
    } catch {
      setHistory([])
    }
  }

  async function openHistoryTask(item: TaskRecord) {
    const runnerId = item.runnerId ?? selectedRunner
    try {
      const response = await apiFetch(useRelayProxy ? `/api/tasks/${runnerId}/${item.id}` : `/api/tasks/${item.id}`)
      if (!response.ok) throw new Error('failed to load task detail')
      const detail = (await response.json()) as TaskDetail
      setTaskId(detail.id)
      if (detail.runnerId) setSelectedRunner(detail.runnerId)
      setState(detail.status)
      setResult(detail.result)
      setEvents(detail.events ?? [])
      setSelectedTaskDetail(detail)
    } catch (error) {
      setTaskId(item.id)
      if (item.runnerId) setSelectedRunner(item.runnerId)
      setState(item.status)
      setResult(item.result)
      setSelectedTaskDetail(item)
      setEvents([{ type: 'log', level: 'error', message: error instanceof Error ? error.message : 'failed to load task detail' }])
    }

    if (item.status === 'queued' || item.status === 'running') {
      connectEventStream(item.id, runnerId)
    }
  }

  function connectEventStream(tId: string, rId = selectedRunner) {
    const eventRunnerId = rId
    const eventBase = useRelayProxy ? relayBase : runnerBase
    const eventParams = new URLSearchParams({ token })
    if (useRelayProxy && relayToken) eventParams.set('relayToken', relayToken)
    const source = new EventSource(`${eventBase}${taskPath('events', tId, eventRunnerId)}?${eventParams.toString()}`)
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as TaskEvent
      setEvents((items) => [...items, event])
      if (event.type === 'state' && event.status) {
        setState(event.status)
        if (event.result) setResult(event.result)
        setSelectedTaskDetail((detail) => detail ? { ...detail, status: event.status!, result: event.result ?? detail.result } : detail)
        if (event.status === 'review' || event.status === 'approved' || event.status === 'applied' || event.status === 'failed' || event.status === 'cancelled') {
          loadHistory()
          source.close()
        }
      }
    }
    source.onerror = () => {
      setEvents((items) => [...items, { type: 'log', level: 'error', message: 'event stream disconnected' }])
      source.close()
    }
  }

  async function startTask() {
    setState(runnerOnline ? 'queued' : 'running')
    setEvents([])
    setResult(null)
    setTaskId(null)
    setSelectedTaskDetail(null)
    setApplyError(null)

    if (batchMode) {
      const lines = task.split(/\r?\n/).filter(Boolean)
      if (lines.length === 0) {
        setEvents([{ type: 'log', level: 'error', message: 'Enter at least one task description in batch mode.' }])
        return
      }
    } else if (!task.trim()) {
      setEvents([{ type: 'log', level: 'error', message: 'Enter a task description before dispatching.' }])
      return
    }

    if (!runnerOnline) {
      runOfflineDemo()
      return
    }

    const response = await apiFetch(useRelayProxy && autoRoute ? '/api/tasks/route' : batchMode ? '/api/tasks/batch' : '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchMode
        ? {
            tasks: task.split(/\r?\n/).filter(Boolean).map((line) => ({
              description: line.trim(),
              runnerId: selectedRunner,
              projectId: selectedProject,
              tool: selectedTool,
              priority: taskPriority,
            })),
          }
        : {
            description: task,
            runnerId: selectedRunner,
            projectId: selectedProject,
            tool: selectedTool,
            priority: taskPriority,
          }),
    })

    if (!response.ok) {
      let message = 'failed to create task on local runner'
      try {
        const payload = (await response.json()) as { error?: string; diagnostics?: unknown }
        message = payload.error ?? message
        if (payload.diagnostics) message = `${message}: ${JSON.stringify(payload.diagnostics)}`
      } catch {
        // Keep fallback message.
      }
      setState('failed')
      setEvents([{ type: 'log', level: 'error', message }])
      return
    }

    const created = (await response.json()) as { id: string; runnerId?: string }
    if (batchMode) {
      const items = Array.isArray(created) ? created : [created]
      setState('draft')
      setResult({ ok: true, durationMs: 0, summary: `${items.length} task(s) queued` })
      setEvents([{ type: 'log', level: 'info', message: `batch dispatched: ${items.length} task(s)` }])
      loadHistory()
      return
    }
    const eventRunnerId = created.runnerId ?? selectedRunner
    if (created.runnerId) setSelectedRunner(created.runnerId)
    setTaskId(created.id)
    setSelectedTaskDetail({
      id: created.id,
      runnerId: eventRunnerId,
      description: task,
      tool: selectedTool,
      status: 'queued',
      createdAt: new Date().toISOString(),
      result: null,
      events: [],
    })
    loadHistory()
    connectEventStream(created.id, eventRunnerId)
  }

  function runOfflineDemo() {
    let index = 0
    const interval = window.setInterval(() => {
      setEvents((items) => [...items, { type: 'log', level: 'info', message: offlineTimeline[index] }])
      index += 1

      if (index >= offlineTimeline.length) {
        window.clearInterval(interval)
        setResult({
          ok: true,
          summary: 'Offline demo completed. Start the local runner for real execution.',
          diff: ['+ Offline demo produced a simulated review result', '+ Start runner with npm run runner'],
        })
        setState('review')
      }
    }, 520)
  }

  async function approveTask() {
    if (taskId && runnerOnline) {
      const response = await apiFetch(taskPath('approve', taskId), { method: 'POST' })
      if (response.ok) {
        const approved = (await response.json()) as { status: TaskState; result: TaskResult | null }
        setState(approved.status)
        if (approved.result) setResult(approved.result)
        loadHistory()
        return
      }
    }

    setState('approved')
  }

  async function applyTask() {
    if (!taskId || !runnerOnline) return

    setApplyError(null)
    const response = await apiFetch(taskPath('apply', taskId), { method: 'POST' })
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      setApplyError(payload.error ?? 'failed to apply approved result')
      return
    }

    const applied = (await response.json()) as { status: TaskState; result: TaskResult | null }
    setState(applied.status)
    if (applied.result) setResult(applied.result)
    setSelectedTaskDetail((detail) => detail ? { ...detail, status: applied.status, result: applied.result } : detail)
    loadHistory()
  }

  async function cancelTask() {
    if (!taskId || !runnerOnline) return

    const response = await apiFetch(taskPath('cancel', taskId), { method: 'POST' })
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      setEvents((items) => [...items, { type: 'log', level: 'error', message: payload.error ?? 'failed to cancel task' }])
      return
    }

    const cancelled = (await response.json()) as { status: TaskState; result: TaskResult | null }
    setState(cancelled.status)
    if (cancelled.result) setResult(cancelled.result)
    setSelectedTaskDetail((detail) => detail ? { ...detail, status: cancelled.status, result: cancelled.result } : detail)
    loadHistory()
  }

  async function retryTask(id = taskId, runnerId = selectedRunner) {
    if (!id || !runnerOnline) return

    const response = await apiFetch(taskPath('retry', id, runnerId), { method: 'POST' })
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      setEvents((items) => [...items, { type: 'log', level: 'error', message: payload.error ?? 'failed to retry task' }])
      return
    }

    const retried = (await response.json()) as { id: string; runnerId?: string }
    const eventRunnerId = retried.runnerId ?? runnerId
    setSelectedRunner(eventRunnerId)
    setTaskId(retried.id)
    setState('queued')
    setEvents([])
    setResult(null)
    setSelectedTaskDetail({
      id: retried.id,
      runnerId: eventRunnerId,
      description: selectedTaskDetail?.description ?? task,
      tool: selectedTool,
      status: 'queued',
      createdAt: new Date().toISOString(),
      retryOf: id,
      result: null,
      events: [],
    })
    loadHistory()
    connectEventStream(retried.id, eventRunnerId)
  }

  async function exportTask() {
    if (!taskId || !runnerOnline) return

    const response = await apiFetch(useRelayProxy ? `/api/tasks/${selectedRunner}/${taskId}/export` : `/api/tasks/${taskId}/export`)
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      setEvents((items) => [...items, { type: 'log', level: 'error', message: payload.error ?? 'failed to export task' }])
      return
    }

    const payload = await response.json()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `omnifleet-${taskId}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function viewTaskLog() {
    if (!taskId || !runnerOnline) return

    try {
      const response = await apiFetch(useRelayProxy ? `/api/tasks/${selectedRunner}/${taskId}/log` : `/api/tasks/${taskId}/log`)
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? 'log not available')
      }
      const log = (await response.json()) as { events: TaskEvent[]; size: number }
      setLogContent(log.events.map((event, index) => {
        const prefix = String(index + 1).padStart(2, '0')
        const msg = event.type === 'log' ? `[${event.level}] ${event.message}` : `[state] ${event.status ?? ''}`
        return `${prefix}  ${msg}`
      }).join('\n'))
      setLogStatus(`${log.events.length} events (${log.size} bytes)`)
    } catch (error) {
      setLogStatus(error instanceof Error ? error.message : 'failed to load log')
    }
  }

  function resetTask() {
    setState('draft')
    setEvents([])
    setResult(null)
    setTaskId(null)
    setSelectedTaskDetail(null)
    setApplyError(null)
  }

  return (
    <main className="shell">
      <header className="hero panel">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div>
          <p className="eyebrow">OmniFleet / landed v0.1</p>
          <h1>AI follows the user. Compute follows the task.</h1>
          <p className="hero-copy">
            A local-first runner network for sending AI coding tasks to trusted devices,
            streaming execution, and approving code changes before they land.
          </p>
        </div>
        <div className="hero-metrics" aria-label="System status">
          <Metric label={relayStatsData ? 'relay' : 'runner'} value={runnerOnline ? 'live' : 'demo'} />
          <Metric
            label="runners"
            value={relayStatsData
              ? String((relayStatsData.runners as Record<string, number>).registered ?? 0)
              : String(currentRunner.tools.length)}
          />
          <Metric
            label="tasks"
            value={runnerStats
              ? String((runnerStats.tasks as Record<string, number>).total ?? 0)
              : '-'}
          />
          <Metric
            label="avg time"
            value={runnerStats?.timing
              ? `${Math.round((runnerStats.timing as Record<string, number>).avgMs / 1000)}s`
              : '-'}
          />
          <Metric
            label="memory"
            value={runnerStats
              ? `${(runnerStats.memory as Record<string, number>).heapUsed}MB`
              : '-'}
          />
          <Metric label="policy" value="locked" />
        </div>
      </header>

      <section className="grid-layout">
        <section className="panel task-panel">
          <div className="section-heading">
            <p className="eyebrow">01 / intent</p>
            <h2>Create task</h2>
          </div>

          <div className={runnerOnline ? 'connection live' : 'connection demo'}>
            {runnerOnline ? `Local runner connected${latencyMs !== null ? ` (${latencyMs}ms)` : ''}${runnerUptime ? ' since ' + runnerUptime : ''}` : 'Runner offline: using demo mode'}
          </div>

          <label className="field-label" htmlFor="token-input">
            Runner token
          </label>
          <div className="token-row">
            <input
              id="token-input"
              type="password"
              value={token}
              placeholder="paste .omnifleet/device.json token"
              onChange={(event) => setToken(event.target.value)}
            />
            <button className="secondary compact" onClick={saveToken}>Save</button>
          </div>
          {authError && <p className="token-hint">{authError}</p>}

          <label className="field-label" htmlFor="relay-input">
            Relay URL
          </label>
          <div className="token-row">
            <input
              id="relay-input"
              value={relayUrl}
              placeholder="http://localhost:8790"
              onChange={(event) => setRelayUrl(event.target.value)}
            />
            <button className="secondary compact" onClick={loadRelayRunners}>Load</button>
          </div>
          {relayStatus && <p className="token-hint neutral-hint">{relayStatus}</p>}

          <label className="field-label" htmlFor="relay-token-input">
            Relay token
          </label>
          <div className="token-row">
            <input
              id="relay-token-input"
              type="password"
              value={relayToken}
              placeholder="paste .omnifleet/relay.json token"
              onChange={(event) => setRelayToken(event.target.value)}
            />
            <button className="secondary compact" onClick={saveRelayToken}>Save</button>
          </div>

          <label className="proxy-toggle">
            <input
              type="checkbox"
              checked={useRelayProxy}
              onChange={(event) => setUseRelayProxy(event.target.checked)}
            />
            <span>Route task API through relay proxy</span>
          </label>

          <label className="proxy-toggle">
            <input
              type="checkbox"
              checked={batchMode}
              onChange={(event) => setBatchMode(event.target.checked)}
            />
            <span>Batch mode: one task per line</span>
          </label>

          <label className="proxy-toggle">
            <input
              type="checkbox"
              checked={autoRoute}
              disabled={!useRelayProxy}
              onChange={(event) => setAutoRoute(event.target.checked)}
            />
            <span>Auto route to an online matching runner</span>
          </label>

          <label className="field-label" htmlFor="task-input">
            Development request
          </label>
          <textarea
            id="task-input"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                startTask()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                resetTask()
              }
            }}
            disabled={state === 'running' || state === 'queued'}
          />

          <div className="templates">
            {[
              'Build the project and show errors',
              'Run tests and report failures',
              'Check for lint or type errors',
              'Review recent changes and suggest improvements',
              'Add inline documentation for new functions',
              'Refactor selected code to reduce duplication',
            ].map((template) => (
              <button
                className="template-chip"
                key={template}
                onClick={() => setTask(template)}
                disabled={state === 'running' || state === 'queued'}
              >
                {template}
              </button>
            ))}
          </div>

          <div className="selector-grid">
            <label>
              <span>Runner</span>
              <select
                value={selectedRunner}
                onChange={(event) => selectRunner(event.target.value)}
                disabled={state === 'running' || state === 'queued'}
              >
                {runners.map((runner) => (
                  <option key={runner.id} value={runner.id}>
                    {runner.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Project</span>
              <select
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
                disabled={state === 'running' || state === 'queued'}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Tool</span>
              <select
                value={selectedTool}
                onChange={(event) => setSelectedTool(event.target.value)}
                disabled={state === 'running' || state === 'queued'}
              >
                {currentRunner.tools.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Priority</span>
              <select
                value={taskPriority}
                onChange={(event) => setTaskPriority(event.target.value)}
                disabled={state === 'running' || state === 'queued'}
              >
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>

          <div className="route-card">
            <div>
              <span className="route-dot" />
              <strong>{currentRunner.name}</strong>
            </div>
            <p>
              {currentRunner.os} / {currentRunner.status} / {currentProject.defaultCommand}
            </p>
            {currentRunner.endpoint && <p>{currentRunner.endpoint}</p>}
            <p>{currentProject.absolutePath}</p>
            {useRelayProxy && (
              <button className="secondary compact route-action" onClick={unregisterRunner} disabled={state === 'running' || state === 'queued'}>
                Unregister runner
              </button>
            )}
          </div>

          <div className="project-register">
            <p className="field-label">Register project on runner</p>
            <input
              value={newProjectName}
              placeholder="Project name"
              onChange={(event) => setNewProjectName(event.target.value)}
            />
            <input
              value={newProjectPath}
              placeholder="Relative or absolute path"
              onChange={(event) => setNewProjectPath(event.target.value)}
            />
            <input
              value={newProjectCommands}
              placeholder="Allowed commands, comma separated"
              onChange={(event) => setNewProjectCommands(event.target.value)}
            />
            <input
              value={newProjectDefaultCommand}
              placeholder="Default command"
              onChange={(event) => setNewProjectDefaultCommand(event.target.value)}
            />
            <button className="secondary compact" onClick={registerProject} disabled={!newProjectName || !newProjectPath}>
              Register project
            </button>
            <button className="secondary compact" onClick={updateProject} disabled={!selectedProject}>
              Update selected project
            </button>
            <button className="secondary compact" onClick={unregisterProject} disabled={!selectedProject}>
              Unregister selected project
            </button>
            {projectStatus && <p className="token-hint neutral-hint">{projectStatus}</p>}
          </div>

          <div className="worktree-section">
            <p className="field-label">Runner worktrees</p>
            <div className="token-row">
              <button className="secondary compact" onClick={fetchWorktrees} disabled={!runnerOnline}>
                List worktrees
              </button>
              <button className="secondary compact" onClick={cleanupWorktrees} disabled={!runnerOnline}>
                Cleanup completed
              </button>
            </div>
            {worktreeStatus && <p className="token-hint neutral-hint">{worktreeStatus}</p>}
            {worktrees.length > 0 && (
              <div className="worktree-list">
                {worktrees.map((item) => (
                  <div className="worktree-item" key={item.taskId}>
                    <span>{item.taskStatus}</span>
                    <code>{item.taskId}</code>
                  </div>
                ))}
              </div>
            )}
            {worktrees.length === 0 && (
              <p className="history-empty">No worktrees found. Worktrees are created when opencode tasks execute.</p>
            )}
          </div>

          <div className="actions">
            <button className="primary" onClick={startTask} disabled={state === 'running' || state === 'queued'}>
              {state === 'draft' ? (batchMode ? 'Dispatch batch' : 'Dispatch task') : 'Run again'}
            </button>
            <button className="secondary" onClick={resetTask} disabled={state === 'running' || state === 'queued'}>
              Reset
            </button>
          </div>
        </section>

        <section className="panel event-panel">
          <div className="section-heading split">
            <div>
              <p className="eyebrow">02 / execution</p>
              <h2>Runner stream</h2>
            </div>
            <StatusPill state={state} />
          </div>

          <div className="node-map" aria-hidden="true">
            <Node active label="User" />
            <Line />
            <Node active={state !== 'draft'} label="API" />
            <Line />
            <Node active={state === 'queued' || state === 'running' || state === 'review' || state === 'approved'} label="Runner" />
            <Line />
            <Node active={state === 'review' || state === 'approved'} label="Review" />
          </div>

          <div className="task-meta">
            <span>task: {taskId ?? 'none'}</span>
            <span>runner: {selectedTaskDetail?.runnerName ?? currentRunner.name}</span>
            <span>project: {selectedProject}</span>
            <span>tool: {selectedTaskDetail?.tool ?? selectedTool}</span>
            <span>priority: {selectedTaskDetail?.priority ?? taskPriority}</span>
            {selectedTaskDetail?.retryOf && <span>retry: {selectedTaskDetail.retryOf}</span>}
          </div>

          <div className="log-window">
            {logEvents.length === 0 ? (
              <p className="empty-log">Task is ready. Dispatch when the runner, project, and tool look correct.</p>
            ) : (
              logEvents.map((event, index) => (
                <p key={`${event.message}-${index}`} className={event.level ?? 'info'}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  {event.message}
                </p>
              ))
            )}
          </div>
        </section>

        <aside className="panel review-panel">
          <div className="section-heading">
            <p className="eyebrow">03 / review</p>
            <h2>Approval gate</h2>
          </div>

          <div className="policy-grid">
            <Policy label="Project path" state="allowed" />
            <Policy label="Safe command" state="allowed" />
            <Policy label="Read secrets" state="denied" />
            <Policy label="Push code" state="denied" />
          </div>

          <div className="diff-card">
            <div className="diff-head">
              <span>{result?.command ?? 'result'}</span>
              <span>{result ? (result.ok ? 'passed' : 'failed') : 'pending'}</span>
            </div>
            <div className="diff-body">
              {result ? (
                <>
                  <p>{result.summary}</p>
                  {typeof result.durationMs === 'number' && <p>duration: {result.durationMs}ms</p>}
                  {typeof result.gitAvailable === 'boolean' && (
                    <p>git: {result.gitAvailable ? result.gitStatus : 'not available'}</p>
                  )}
                  {result.worktreeBranch && <p>worktree branch: {result.worktreeBranch}</p>}
                  {result.worktreePath && <p>worktree path: {result.worktreePath}</p>}
                  {result.agentGitStatus && <p>agent status: {result.agentGitStatus}</p>}
                  {result.changeStat && <p className="diff-stat">{result.changeStat}</p>}
                  {result.changedFiles && result.changedFiles.length > 0 && (
                    <p>modified: {result.changedFiles.join(', ')}</p>
                  )}
                  {result.appliedAt && <p>applied at: {result.appliedAt}</p>}
                  {diffLines.map((line) => <p key={line}>{line}</p>)}
                </>
              ) : (
                <p className="empty-log">Result will appear after execution completes.</p>
              )}
            </div>
          </div>

          <div className="review-actions">
            <button className="primary" disabled={state !== 'review'} onClick={approveTask}>
              Approve result
            </button>
            <button className="secondary" disabled={state !== 'review'} onClick={startTask}>
              Continue task
            </button>
            <button className="secondary" disabled={state !== 'approved' || !result?.worktreePath} onClick={applyTask}>
              Apply patch
            </button>
            <button className="secondary" disabled={!['queued', 'running'].includes(state)} onClick={cancelTask}>
              Cancel task
            </button>
            <button className="secondary" disabled={!taskId || ['queued', 'running'].includes(state)} onClick={() => retryTask()}>
              Retry task
            </button>
            <button className="secondary" disabled={!taskId} onClick={exportTask}>
              Export JSON
            </button>
            <button className="secondary" disabled={!taskId} onClick={viewTaskLog}>
              View log
            </button>
          </div>

          {state === 'approved' && (
            <p className="approval-note">Approved locally. Apply patch is separate; commit and push still require explicit confirmation.</p>
          )}

          {state === 'applied' && (
            <p className="approval-note">Patch applied to the main workspace index. Commit and push still require explicit confirmation.</p>
          )}

          {applyError && (
            <p className="approval-note error-note">{applyError}</p>
          )}

          {logContent && (
            <div className="log-viewer">
              <div className="log-viewer-head">
                <span>Task log</span>
                <span>{logStatus}</span>
              </div>
              <pre>{logContent}</pre>
            </div>
          )}
        </aside>
      </section>

      <section className="panel history-panel">
        <div className="section-heading split">
          <div>
            <p className="eyebrow">04 / memory</p>
            <h2>Task history</h2>
          </div>
          <button className="secondary compact" onClick={loadHistory} disabled={!runnerOnline}>
            Refresh
          </button>
        </div>
        {lastHistoryRefresh && <p className="history-refreshed">Last refresh: {lastHistoryRefresh}</p>}

        {history.length > 0 && (
          <>
            <div className="history-summary">
              {['total', 'queued', 'running', 'review', 'approved', 'applied', 'failed', 'cancelled'].map((status) => (
                <button
                  className={historyStatus === status || (status === 'total' && historyStatus === 'all') ? 'summary-chip active' : 'summary-chip'}
                  key={status}
                  onClick={() => setHistoryStatus(status === 'total' ? 'all' : (status as TaskState))}
                >
                  <span>{status}</span>
                  <strong>{historyCounts[status] ?? 0}</strong>
                </button>
              ))}
            </div>
            <div className="history-filters">
              <input
                value={historyQuery}
                placeholder="Filter by task, runner, tool, description"
                onChange={(event) => setHistoryQuery(event.target.value)}
              />
              <select value={historyStatus} onChange={(event) => setHistoryStatus(event.target.value as TaskState | 'all')}>
                <option value="all">All statuses</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
                <option value="review">Review</option>
                <option value="approved">Approved</option>
                <option value="applied">Applied</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          </>
        )}

        {history.length === 0 ? (
          <p className="history-empty">No persisted tasks yet. Start the local runner and dispatch a task.</p>
        ) : filteredHistory.length === 0 ? (
          <p className="history-empty">No tasks match the current filters.</p>
        ) : (
          <div className="history-grid">
            {filteredHistory.map((item) => (
              <button
                className="history-item"
                key={item.id}
                onClick={() => openHistoryTask(item)}
              >
                <span>{item.status}</span>
                <strong>{item.description || item.id}</strong>
                {item.retryOf && <small>retry of {item.retryOf}</small>}
                {item.priority && item.priority !== 'normal' && <small>{item.priority}</small>}
                {item.routing && <small>{item.routing.mode}: {item.routing.selectedRunnerName}</small>}
                <small>{item.runnerName ? `${item.runnerName} / ` : ''}{item.tool} / {new Date(item.createdAt).toLocaleString()}</small>
                <span
                  className="history-reuse"
                  title="Copy prompt to task input"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (item.description) setTask(item.description)
                    if (item.tool) setSelectedTool(item.tool)
                    if (item.runnerId) setSelectedRunner(item.runnerId)
                  }}
                >
                  &crarr; Reuse
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function StatusPill({ state }: { state: TaskState }) {
  return <span className={`status-pill ${state}`}>{state}</span>
}

function Node({ active, label }: { active: boolean; label: string }) {
  return <div className={active ? 'node active' : 'node'}>{label}</div>
}

function Line() {
  return <div className="line" />
}

function Policy({ label, state }: { label: string; state: 'allowed' | 'denied' }) {
  return (
    <div className={`policy ${state}`}>
      <span>{label}</span>
      <strong>{state}</strong>
    </div>
  )
}
