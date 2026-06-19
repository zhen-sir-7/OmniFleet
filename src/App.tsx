import { useEffect, useState } from 'react'

type TaskState = 'draft' | 'queued' | 'running' | 'review' | 'approved' | 'applied' | 'failed'

type Runner = {
  id: string
  name: string
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
}

type TaskEvent = {
  type: 'log' | 'state'
  level?: 'info' | 'stdout' | 'stderr' | 'error'
  message?: string
  status?: TaskState
  result?: TaskResult | null
}

const apiBase = import.meta.env.DEV ? 'http://localhost:8787' : ''

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
  const [state, setState] = useState<TaskState>('draft')
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [result, setResult] = useState<TaskResult | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [runnerOnline, setRunnerOnline] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  useEffect(() => {
    async function loadRunner() {
      try {
        const [runnerResponse, projectResponse] = await Promise.all([
          fetch(`${apiBase}/api/runners`),
          fetch(`${apiBase}/api/projects`),
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
      } catch {
        setRunnerOnline(false)
      }
    }

    loadRunner()
  }, [])

  const currentRunner = runners.find((runner) => runner.id === selectedRunner) ?? runners[0]
  const currentProject = projects.find((project) => project.id === selectedProject) ?? projects[0]
  const logEvents = events.filter((event) => event.type === 'log')
  const diffLines = result?.diff ?? []

  async function startTask() {
    setState(runnerOnline ? 'queued' : 'running')
    setEvents([])
    setResult(null)
    setTaskId(null)
    setApplyError(null)

    if (!runnerOnline) {
      runOfflineDemo()
      return
    }

    const response = await fetch(`${apiBase}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: task,
        runnerId: selectedRunner,
        projectId: selectedProject,
        tool: selectedTool,
      }),
    })

    if (!response.ok) {
      setState('failed')
      setEvents([{ type: 'log', level: 'error', message: 'failed to create task on local runner' }])
      return
    }

    const created = (await response.json()) as { id: string }
    setTaskId(created.id)
    const source = new EventSource(`${apiBase}/api/tasks/${created.id}/events`)

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as TaskEvent
      setEvents((items) => [...items, event])

      if (event.type === 'state' && event.status) {
        setState(event.status)
        if (event.result) setResult(event.result)
        if (event.status === 'review' || event.status === 'approved' || event.status === 'applied' || event.status === 'failed') {
          source.close()
        }
      }
    }

    source.onerror = () => {
      setEvents((items) => [...items, { type: 'log', level: 'error', message: 'event stream disconnected' }])
      source.close()
    }
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
      const response = await fetch(`${apiBase}/api/tasks/${taskId}/approve`, { method: 'POST' })
      if (response.ok) {
        const approved = (await response.json()) as { status: TaskState; result: TaskResult | null }
        setState(approved.status)
        if (approved.result) setResult(approved.result)
        return
      }
    }

    setState('approved')
  }

  async function applyTask() {
    if (!taskId || !runnerOnline) return

    setApplyError(null)
    const response = await fetch(`${apiBase}/api/tasks/${taskId}/apply`, { method: 'POST' })
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      setApplyError(payload.error ?? 'failed to apply approved result')
      return
    }

    const applied = (await response.json()) as { status: TaskState; result: TaskResult | null }
    setState(applied.status)
    if (applied.result) setResult(applied.result)
  }

  function resetTask() {
    setState('draft')
    setEvents([])
    setResult(null)
    setTaskId(null)
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
          <Metric label="runner" value={runnerOnline ? 'live' : 'demo'} />
          <Metric label="tools" value={String(currentRunner.tools.length)} />
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
            {runnerOnline ? 'Local runner connected' : 'Runner offline: using demo mode'}
          </div>

          <label className="field-label" htmlFor="task-input">
            Development request
          </label>
          <textarea
            id="task-input"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            disabled={state === 'running' || state === 'queued'}
          />

          <div className="selector-grid">
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
          </div>

          <div className="route-card">
            <div>
              <span className="route-dot" />
              <strong>{currentRunner.name}</strong>
            </div>
            <p>
              {currentRunner.os} / {currentRunner.status} / {currentProject.defaultCommand}
            </p>
            <p>{currentProject.absolutePath}</p>
          </div>

          <div className="actions">
            <button className="primary" onClick={startTask} disabled={state === 'running' || state === 'queued'}>
              {state === 'draft' ? 'Dispatch task' : 'Run again'}
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
        </aside>
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
