import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const config = JSON.parse(readFileSync(join(root, 'omnifleet.config.json'), 'utf8'))
const port = Number(process.env.OMNIFLEET_PORT ?? 8787)
const stateDir = resolve(root, '.omnifleet')
const taskStorePath = resolve(stateDir, 'tasks.json')
const deviceStorePath = resolve(stateDir, 'device.json')
const projectStorePath = resolve(stateDir, 'projects.json')
const tasks = loadTasks()
const subscribers = new Map()
const runningProcesses = new Map()
const device = loadDevice()
const runnerStartedAt = new Date().toISOString()
const taskQueue = []
let taskRunning = false

function priorityWeight(priority) {
  if (priority === 'high') return 0
  if (priority === 'low') return 2
  return 1
}

async function drainQueue() {
  if (taskRunning) return
  if (taskQueue.length === 0) return

  taskRunning = true
  while (taskQueue.length > 0) {
    taskQueue.sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority) || a.createdAt.localeCompare(b.createdAt))
    const next = taskQueue.shift()
    const task = tasks.get(next.id)
    if (!task || task.status !== 'queued') continue
    await runTask(next.id)
  }
  taskRunning = false
}

function loadTasks() {
  try {
    if (!existsSync(taskStorePath)) return new Map()
    const items = JSON.parse(readFileSync(taskStorePath, 'utf8'))
    return new Map(items.map((task) => [task.id, task]))
  } catch {
    return new Map()
  }
}

function saveTasks() {
  mkdirSync(stateDir, { recursive: true })
  const items = Array.from(tasks.values()).slice(-100)
  writeFileSync(taskStorePath, JSON.stringify(items, null, 2), 'utf8')
}

function loadRegisteredProjects() {
  try {
    if (!existsSync(projectStorePath)) return []
    const projects = JSON.parse(readFileSync(projectStorePath, 'utf8'))
    return Array.isArray(projects) ? projects : []
  } catch {
    return []
  }
}

function saveRegisteredProjects(projects) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(projectStorePath, JSON.stringify(projects, null, 2), 'utf8')
}

function loadDevice() {
  mkdirSync(stateDir, { recursive: true })
  try {
    if (existsSync(deviceStorePath)) return JSON.parse(readFileSync(deviceStorePath, 'utf8'))
  } catch {
    // Regenerate below if the local device file is unreadable.
  }

  const nextDevice = {
    id: config.runner.id,
    name: config.runner.name,
    token: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
  }
  writeFileSync(deviceStorePath, JSON.stringify(nextDevice, null, 2), 'utf8')
  return nextDevice
}

function unauthorized(res) {
  return json(res, 401, { error: 'Missing or invalid X-OmniFleet-Token header.' })
}

function isAuthorized(req, url) {
  const token = req.headers['x-omnifleet-token']
  const queryToken = url.searchParams.get('token')
  return (typeof token === 'string' && token === device.token) || queryToken === device.token
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
  })
}

function commandParts(command) {
  if (process.platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] }
  return { command: 'sh', args: ['-c', command] }
}

function runShell(command, options = {}) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now()
    const parts = commandParts(command)
    const stdout = []
    const stderr = []
    const child = spawn(parts.command, parts.args, {
      cwd: options.cwd ?? root,
      env: process.env,
      windowsHide: true,
    })
    if (options.taskId) runningProcesses.set(options.taskId, child)
    let settled = false
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGTERM')
          if (options.taskId) runningProcesses.delete(options.taskId)
          stderr.push(`Command timed out after ${options.timeoutMs}ms`)
          resolveRun({ ok: false, code: -2, stdout: stdout.join(''), stderr: stderr.join(''), durationMs: Date.now() - startedAt })
        }, options.timeoutMs)
      : null

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout.push(text)
      options.onStdout?.(text)
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr.push(text)
      options.onStderr?.(text)
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (options.taskId) runningProcesses.delete(options.taskId)
      stderr.push(error.message)
      resolveRun({ ok: false, code: -1, stdout: stdout.join(''), stderr: stderr.join(''), durationMs: Date.now() - startedAt })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (options.taskId) runningProcesses.delete(options.taskId)
      resolveRun({ ok: code === 0, code, stdout: stdout.join(''), stderr: stderr.join(''), durationMs: Date.now() - startedAt })
    })
  })
}

function cancelTask(taskId) {
  const task = tasks.get(taskId)
  if (!task) return { ok: false, status: 404, summary: 'Task not found.' }
  if (!['queued', 'running'].includes(task.status)) return { ok: false, status: 409, summary: `Task is not cancellable from status: ${task.status}` }

  const child = runningProcesses.get(taskId)
  if (child) {
    child.kill('SIGTERM')
    runningProcesses.delete(taskId)
  }

  updateTask(taskId, {
    status: 'cancelled',
    result: {
      ok: false,
      summary: child ? 'Task cancellation requested; running process was terminated.' : 'Task cancelled before a process was started.',
      cancelledAt: new Date().toISOString(),
    },
  })
  return { ok: true, status: 200, task: publicTask(tasks.get(taskId)) }
}

async function commandExists(command) {
  const checkCommand = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`
  const result = await runShell(checkCommand)
  return result.ok
}

function sendEvent(taskId, event) {
  const task = tasks.get(taskId)
  if (!task) return

  task.events.push(event)
  saveTasks()
  const clients = subscribers.get(taskId) ?? new Set()
  for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function updateTask(taskId, patch) {
  const task = tasks.get(taskId)
  if (!task) return
  Object.assign(task, patch)
  saveTasks()
  sendEvent(taskId, { type: 'state', status: task.status, result: task.result ?? null })
}

function publicTask(task) {
  return {
    id: task.id,
    description: task.description,
    runnerId: task.runnerId,
    projectId: task.projectId,
    tool: task.tool,
    priority: task.priority ?? 'normal',
    status: task.status,
    createdAt: task.createdAt,
    retryOf: task.retryOf ?? null,
    result: task.result ?? null,
    events: task.events,
  }
}

function normalizeProjects() {
  const registered = loadRegisteredProjects()
  const merged = [...config.projects, ...registered]
  const seen = new Set()
  return merged.filter((project) => {
    if (seen.has(project.id)) return false
    seen.add(project.id)
    return true
  }).map((project) => ({
    ...project,
    absolutePath: resolve(root, project.path),
  }))
}

function projectIdFromName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function registerProject(body) {
  const name = String(body.name ?? '').trim()
  const rawPath = String(body.path ?? '').trim()
  const id = String(body.id ?? projectIdFromName(name)).trim()
  const allowedCommands = Array.isArray(body.allowedCommands) && body.allowedCommands.length > 0 ? body.allowedCommands.map(String) : ['npm run build']
  const defaultCommand = String(body.defaultCommand ?? allowedCommands[0])

  if (!id || !name || !rawPath) return { ok: false, status: 400, error: 'id, name, and path are required.' }
  const absolutePath = resolve(root, rawPath)
  if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) return { ok: false, status: 400, error: 'Project path must exist and be a directory.' }
  if (!allowedCommands.includes(defaultCommand)) return { ok: false, status: 400, error: 'defaultCommand must be included in allowedCommands.' }

  const registered = loadRegisteredProjects().filter((project) => project.id !== id)
  const project = { id, name, path: rawPath, allowedCommands, defaultCommand }
  registered.push(project)
  saveRegisteredProjects(registered)
  return { ok: true, status: 201, project: { ...project, absolutePath } }
}

function unregisterProject(projectId) {
  if (config.projects.some((project) => project.id === projectId)) {
    return { ok: false, status: 409, error: 'Built-in config projects cannot be unregistered via API.' }
  }

  const registered = loadRegisteredProjects()
  const nextProjects = registered.filter((project) => project.id !== projectId)
  if (nextProjects.length === registered.length) return { ok: false, status: 404, error: 'Registered project not found.' }
  saveRegisteredProjects(nextProjects)
  return { ok: true, status: 200 }
}

function updateProject(projectId, body) {
  if (config.projects.some((project) => project.id === projectId)) {
    return { ok: false, status: 409, error: 'Built-in config projects cannot be updated via API.' }
  }

  const registered = loadRegisteredProjects()
  const index = registered.findIndex((project) => project.id === projectId)
  if (index === -1) return { ok: false, status: 404, error: 'Registered project not found.' }

  const current = registered[index]
  const next = {
    ...current,
    name: body.name === undefined ? current.name : String(body.name).trim(),
    path: body.path === undefined ? current.path : String(body.path).trim(),
    allowedCommands: Array.isArray(body.allowedCommands) && body.allowedCommands.length > 0
      ? body.allowedCommands.map(String)
      : current.allowedCommands,
  }
  next.defaultCommand = body.defaultCommand === undefined ? current.defaultCommand : String(body.defaultCommand)

  if (!next.name || !next.path) return { ok: false, status: 400, error: 'name and path are required.' }
  const absolutePath = resolve(root, next.path)
  if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) return { ok: false, status: 400, error: 'Project path must exist and be a directory.' }
  if (!next.allowedCommands.includes(next.defaultCommand)) return { ok: false, status: 400, error: 'defaultCommand must be included in allowedCommands.' }

  registered[index] = next
  saveRegisteredProjects(registered)
  return { ok: true, status: 200, project: { ...next, absolutePath } }
}

function streamLines(taskId, level, chunk) {
  for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
    sendEvent(taskId, { type: 'log', level, message: line })
  }
}

async function collectGit(project) {
  const isRepo = await runShell('git rev-parse --is-inside-work-tree', { cwd: project.absolutePath })
  if (!isRepo.ok) {
    return { available: false, status: 'not a git repository', diff: [] }
  }

  const status = await runShell('git status --short', { cwd: project.absolutePath })
  const diff = await runShell('git diff --no-ext-diff -- src runner omnifleet.config.json package.json README.md', {
    cwd: project.absolutePath,
  })
  const diffLines = diff.stdout.split(/\r?\n/).filter(Boolean)

  return {
    available: true,
    status: status.stdout.trim() || 'clean',
    diff: diffLines.length > 0 ? diffLines.slice(0, 240) : ['No working tree diff detected.'],
  }
}

async function collectWorktreeChanges(project) {
  const isRepo = await runShell('git rev-parse --is-inside-work-tree', { cwd: project.absolutePath })
  if (!isRepo.ok) return { changedFiles: [], stat: 'not a git repository' }

  const nameOnly = await runShell('git diff --name-only', { cwd: project.absolutePath })
  const stat = await runShell('git diff --stat', { cwd: project.absolutePath })

  return {
    changedFiles: nameOnly.stdout.split(/\r?\n/).filter(Boolean).slice(0, 60),
    stat: stat.stdout.trim() || 'no changes',
  }
}

function shellQuote(path) {
  return `"${String(path).replace(/"/g, '\\"')}"`
}

async function applyTaskResult(taskId) {
  const task = tasks.get(taskId)
  const project = normalizeProjects().find((item) => item.id === task?.projectId)

  if (!task || !project) return { ok: false, summary: 'Task or project not found.' }
  if (task.status !== 'approved') return { ok: false, summary: 'Task must be approved before applying.' }
  if (!task.result?.worktreePath) return { ok: false, summary: 'Task has no isolated worktree result to apply.' }
  if (!existsSync(task.result.worktreePath)) return { ok: false, summary: 'Task worktree no longer exists.' }

  const mainGit = await collectGit(project)
  if (mainGit.available && mainGit.status !== 'clean') {
    return { ok: false, summary: `Main workspace is not clean: ${mainGit.status}` }
  }

  const diff = await runShell('git diff --binary', { cwd: task.result.worktreePath })
  if (!diff.ok || !diff.stdout.trim()) return { ok: false, summary: 'No worktree diff to apply.' }

  const patchPath = resolve(root, '.omnifleet', `${taskId}.patch`)
  mkdirSync(resolve(root, '.omnifleet'), { recursive: true })
  await import('node:fs').then((fs) => fs.writeFileSync(patchPath, diff.stdout, 'utf8'))

  const check = await runShell(`git apply --check ${shellQuote(patchPath)}`, { cwd: project.absolutePath })
  if (!check.ok) return { ok: false, summary: check.stderr || check.stdout || 'Patch does not apply cleanly.' }

  const apply = await runShell(`git apply --index ${shellQuote(patchPath)}`, { cwd: project.absolutePath })
  if (!apply.ok) return { ok: false, summary: apply.stderr || apply.stdout || 'Patch apply failed.' }

  const appliedGit = await collectGit(project)
  task.status = 'applied'
  task.result = {
    ...task.result,
    applied: true,
    appliedAt: new Date().toISOString(),
    summary: 'Approved worktree patch applied to the main workspace index. Commit and push still require explicit action.',
    gitStatus: appliedGit.status,
    diff: appliedGit.diff,
  }
  sendEvent(taskId, { type: 'state', status: task.status, result: task.result })
  return { ok: true, task: publicTask(task) }
}

async function prepareTaskWorkspace(taskId, project) {
  const isRepo = await runShell('git rev-parse --is-inside-work-tree', { cwd: project.absolutePath })
  if (!isRepo.ok) return { ok: false, path: project.absolutePath, summary: 'Project is not a git repository; refusing agent execution.' }

  const worktreeRoot = resolve(root, config.security?.worktreeRoot ?? '.omnifleet/worktrees')
  const taskPath = resolve(worktreeRoot, taskId)
  mkdirSync(worktreeRoot, { recursive: true })
  if (existsSync(taskPath)) rmSync(taskPath, { recursive: true, force: true })

  const branch = `omnifleet/${taskId}`
  const result = await runShell(`git worktree add -B ${branch} "${taskPath}" HEAD`, { cwd: project.absolutePath })
  if (!result.ok) {
    return { ok: false, path: project.absolutePath, summary: result.stderr || result.stdout || 'Failed to create task worktree.' }
  }

  return { ok: true, path: taskPath, branch, summary: `Created isolated worktree: ${taskPath}` }
}

function safeAgentPrompt(task, project) {
  return [
    'You are running inside an OmniFleet isolated task worktree.',
    'Follow these safety rules strictly:',
    '- Do not commit, push, publish, deploy, delete broad paths, or read secret files.',
    '- Do not access .env, .ssh, .aws, private keys, credentials, or token files.',
    '- Keep changes minimal and focused on the user request.',
    '- If a command looks destructive or needs secrets, stop and explain instead.',
    `Project: ${project.name}`,
    `User request: ${task.description}`,
  ].join('\n')
}

function createAdapters() {
  return {
    'build-check': {
      label: 'Build Check',
      detect: async () => true,
      run: async ({ taskId, project }) => {
        const command = project.defaultCommand
        if (!project.allowedCommands.includes(command)) {
          return { ok: false, command, durationMs: 0, summary: `Command is not allowed by policy: ${command}` }
        }

        sendEvent(taskId, { type: 'log', level: 'info', message: `safe command started: ${command}` })
        const run = await runShell(command, {
          taskId,
          cwd: project.absolutePath,
          onStdout: (chunk) => streamLines(taskId, 'stdout', chunk),
          onStderr: (chunk) => streamLines(taskId, 'stderr', chunk),
        })

        return {
          ok: run.ok,
          command,
          durationMs: run.durationMs,
          summary: run.ok
            ? 'Build check completed successfully. Result is ready for approval.'
            : `Build check failed with exit code ${run.code}. Review logs before continuing.`,
        }
      },
    },
    'mock-agent': {
      label: 'Mock Agent',
      detect: async () => true,
      run: async ({ taskId }) => {
        for (const message of ['mock adapter received task', 'mock adapter inspected policy', 'mock adapter produced review result']) {
          sendEvent(taskId, { type: 'log', level: 'info', message })
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 220))
        }
        return { ok: true, command: 'mock-agent', durationMs: 660, summary: 'Mock adapter completed successfully.' }
      },
    },
    opencode: {
      label: 'opencode',
      detect: async () => commandExists('opencode'),
      run: async ({ taskId, task, project }) => {
        const workspace = await prepareTaskWorkspace(taskId, project)
        if (!workspace.ok) return { ok: false, command: 'opencode', durationMs: 0, summary: workspace.summary }

        sendEvent(taskId, { type: 'log', level: 'info', message: workspace.summary })
        const prompt = safeAgentPrompt(task, project).replace(/"/g, '\\"')
        const format = config.adapters?.opencode?.format === 'json' ? '--format json' : ''
        const command = `opencode run ${format} --dir "${workspace.path}" "${prompt}"`
        sendEvent(taskId, { type: 'log', level: 'info', message: 'opencode started inside isolated worktree' })

        const run = await runShell(command, {
          taskId,
          cwd: workspace.path,
          timeoutMs: config.security?.taskTimeoutMs ?? 120000,
          onStdout: (chunk) => streamLines(taskId, 'stdout', chunk),
          onStderr: (chunk) => streamLines(taskId, 'stderr', chunk),
        })

        const git = await collectGit({ ...project, absolutePath: workspace.path })
        const changes = await collectWorktreeChanges({ ...project, absolutePath: workspace.path })
        sendEvent(taskId, { type: 'log', level: 'info', message: `${changes.changedFiles.length} file(s) modified in worktree` })
        return {
          ok: run.ok,
          command: 'opencode run',
          durationMs: run.durationMs,
          worktreePath: workspace.path,
          worktreeBranch: workspace.branch,
          agentGitStatus: git.status,
          agentDiff: git.diff,
          changedFiles: changes.changedFiles,
          changeStat: changes.stat,
          summary: run.ok
            ? 'opencode completed inside an isolated worktree. Review the agent diff before applying anything to the main workspace.'
            : `opencode exited with code ${run.code}. Review logs and isolated worktree state before continuing.`,
        }
      },
    },
    claude: {
      label: 'Claude Code',
      detect: async () => commandExists('claude'),
      run: async () => ({ ok: false, command: 'claude', durationMs: 0, summary: 'Claude Code adapter is detected but execution wiring is not enabled yet.' }),
    },
    codex: {
      label: 'Codex',
      detect: async () => commandExists('codex'),
      run: async () => ({ ok: false, command: 'codex', durationMs: 0, summary: 'Codex adapter is detected but execution wiring is not enabled yet.' }),
    },
  }
}

async function availableTools() {
  const adapters = createAdapters()
  const detected = []
  for (const [name, adapter] of Object.entries(adapters)) {
    if (await adapter.detect()) detected.push(name)
  }
  return detected
}

async function runnerPayload() {
  return {
    ...config.runner,
    deviceId: device.id,
    tools: await availableTools(),
    status: 'online',
    projects: normalizeProjects().map((project) => project.name),
  }
}

async function registerWithRelay() {
  const relayUrl = process.env.OMNIFLEET_RELAY_URL
  if (!relayUrl) return

  try {
    const payload = await runnerPayload()
    await fetch(`${relayUrl.replace(/\/$/, '')}/api/runners/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.OMNIFLEET_RELAY_TOKEN ? { 'X-OmniFleet-Relay-Token': process.env.OMNIFLEET_RELAY_TOKEN } : {}),
      },
      body: JSON.stringify({
        id: payload.deviceId,
        name: payload.name,
        endpoint: process.env.OMNIFLEET_RUNNER_URL ?? `http://localhost:${port}`,
        tools: payload.tools,
        projects: payload.projects,
        capabilities: payload.capabilities,
      }),
    })
  } catch (error) {
    console.warn(`Relay registration failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

async function runTask(taskId) {
  const task = tasks.get(taskId)
  const project = normalizeProjects().find((item) => item.id === task?.projectId)

  if (!task || !project) return
  if (task.status === 'cancelled') return

  updateTask(taskId, { status: 'running' })
  sendEvent(taskId, { type: 'log', level: 'info', message: `task accepted by ${config.runner.name}` })
  sendEvent(taskId, { type: 'log', level: 'info', message: `project context loaded: ${project.name}` })
  sendEvent(taskId, { type: 'log', level: 'info', message: 'policy check: project path is whitelisted' })
  sendEvent(taskId, { type: 'log', level: 'info', message: `tool selected: ${task.tool}` })

  if (!existsSync(project.absolutePath) || !statSync(project.absolutePath).isDirectory()) {
    updateTask(taskId, { status: 'failed', result: { ok: false, summary: 'Project path does not exist or is not a directory.' } })
    return
  }

  const adapters = createAdapters()
  const adapter = adapters[task.tool]
  if (!adapter || !(await adapter.detect())) {
    updateTask(taskId, { status: 'failed', result: { ok: false, summary: `Tool is unavailable on this runner: ${task.tool}` } })
    return
  }

  const run = await adapter.run({ taskId, task, project })
  if (tasks.get(taskId)?.status === 'cancelled') return
  const git = await collectGit(project)
  const resultDiff = Array.isArray(run.agentDiff) ? run.agentDiff : git.diff

  updateTask(taskId, {
    status: 'review',
    result: {
      ...run,
      gitStatus: git.status,
      gitAvailable: git.available,
      diff: resultDiff,
    },
  })
}

function serveStatic(req, res) {
  const dist = join(root, 'dist')
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1)
  const filePath = resolve(dist, requested)

  if (!filePath.startsWith(dist) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    const fallback = join(dist, 'index.html')
    if (!existsSync(fallback)) return json(res, 404, { error: 'Build not found. Run npm run build first.' })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    createReadStream(fallback).pipe(res)
    return
  }

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
  }
  res.writeHead(200, { 'Content-Type': types[extname(filePath)] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(res)
}

function createTask(body, retryOf = null) {
  const id = `task_${Date.now()}`
  const task = {
    id,
    description: String(body.description ?? '').trim(),
    runnerId: body.runnerId ?? config.runner.id,
    projectId: body.projectId ?? config.projects[0].id,
    tool: body.tool ?? config.runner.tools[0],
    priority: ['high', 'low'].includes(String(body.priority ?? '')) ? String(body.priority) : 'normal',
    status: 'queued',
    createdAt: new Date().toISOString(),
    retryOf,
    events: [],
  }
  tasks.set(id, task)
  saveTasks()
  taskQueue.push(task)
  setTimeout(() => drainQueue(), 250)
  return task
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'OPTIONS') return json(res, 204, {})

  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, tokenRequired: true, runner: { id: device.id, name: device.name, startedAt: runnerStartedAt, uptimeMs: Date.now() - Date.parse(runnerStartedAt) } })

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const allTasks = Array.from(tasks.values())
      const byStatus = {}
      for (const task of allTasks) {
        byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
      }
      const memUsage = process.memoryUsage()
      return json(res, 200, {
        tasks: { total: allTasks.length, ...byStatus },
        queueLength: taskQueue.length,
        runningProcesses: runningProcesses.size,
        memory: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
        uptimeMs: Date.now() - Date.parse(runnerStartedAt),
        platform: process.platform,
        nodeVersion: process.version,
      })
    }

    if (url.pathname.startsWith('/api/') && !isAuthorized(req, url)) return unauthorized(res)

    if (url.pathname === '/api/runners') return json(res, 200, [await runnerPayload()])
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, normalizeProjects())

    if (url.pathname === '/api/projects' && req.method === 'POST') {
      const registered = registerProject(await readBody(req))
      return json(res, registered.status, registered.ok ? registered.project : { error: registered.error })
    }

    const projectDeleteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
    if (projectDeleteMatch && req.method === 'DELETE') {
      const deleted = unregisterProject(projectDeleteMatch[1])
      return json(res, deleted.status, deleted.ok ? { ok: true } : { error: deleted.error })
    }

    const projectUpdateMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
    if (projectUpdateMatch && req.method === 'PATCH') {
      const updated = updateProject(projectUpdateMatch[1], await readBody(req))
      return json(res, updated.status, updated.ok ? updated.project : { error: updated.error })
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readBody(req)
      const task = createTask(body)
      return json(res, 201, publicTask(task))
    }

    if (url.pathname === '/api/tasks/batch' && req.method === 'POST') {
      const body = await readBody(req)
      const items = Array.isArray(body.tasks) ? body.tasks : []
      if (items.length === 0) return json(res, 400, { error: 'Provide a tasks array with at least one item.' })
      const created = items.map((item) => createTask(item))
      return json(res, 201, created.map(publicTask))
    }

    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const items = Array.from(tasks.values())
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 50)
        .map(publicTask)
      return json(res, 200, items)
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)
    if (taskMatch && req.method === 'GET') {
      const task = tasks.get(taskMatch[1])
      return task ? json(res, 200, publicTask(task)) : json(res, 404, { error: 'Task not found' })
    }

    const approveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/)
    if (approveMatch && req.method === 'POST') {
      const task = tasks.get(approveMatch[1])
      if (!task) return json(res, 404, { error: 'Task not found' })
      updateTask(task.id, { status: 'approved' })
      return json(res, 200, publicTask(task))
    }

    const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)
    if (cancelMatch && req.method === 'POST') {
      const cancelled = cancelTask(cancelMatch[1])
      return json(res, cancelled.status, cancelled.ok ? cancelled.task : { error: cancelled.summary })
    }

    const retryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/)
    if (retryMatch && req.method === 'POST') {
      const original = tasks.get(retryMatch[1])
      if (!original) return json(res, 404, { error: 'Task not found' })
      const task = createTask(original, original.id)
      return json(res, 201, publicTask(task))
    }

    const exportMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/export$/)
    if (exportMatch && req.method === 'GET') {
      const task = tasks.get(exportMatch[1])
      if (!task) return json(res, 404, { error: 'Task not found' })
      return json(res, 200, {
        exportedAt: new Date().toISOString(),
        runner: await runnerPayload(),
        task,
      })
    }

    const applyMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/apply$/)
    if (applyMatch && req.method === 'POST') {
      const applied = await applyTaskResult(applyMatch[1])
      return applied.ok ? json(res, 200, applied.task) : json(res, 409, { error: applied.summary })
    }

    const eventMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events$/)
    if (eventMatch && req.method === 'GET') {
      const taskId = eventMatch[1]
      const task = tasks.get(taskId)
      if (!task) return json(res, 404, { error: 'Task not found' })

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(': connected\n\n')

      if (!subscribers.has(taskId)) subscribers.set(taskId, new Set())
      subscribers.get(taskId).add(res)
      for (const event of task.events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      req.on('close', () => subscribers.get(taskId)?.delete(res))
      return
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' })
    return serveStatic(req, res)
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
})

server.listen(port, () => {
  console.log(`OmniFleet runner listening on http://localhost:${port}`)
  registerWithRelay()
  if (process.env.OMNIFLEET_RELAY_URL) setInterval(registerWithRelay, 30000)
})
