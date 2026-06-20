import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const stateDir = resolve(root, '.omnifleet')
const relayStorePath = resolve(stateDir, 'relay.json')
const registryPath = resolve(stateDir, 'relay-runners.json')
const taskStorePath = resolve(stateDir, 'relay-tasks.json')
const port = Number(process.env.OMNIFLEET_RELAY_PORT ?? 8790)
const relay = loadRelay()
const runners = loadRegistry()
const tasks = loadTasks()

function loadRelay() {
  mkdirSync(stateDir, { recursive: true })
  try {
    if (existsSync(relayStorePath)) return JSON.parse(readFileSync(relayStorePath, 'utf8'))
  } catch {
    // Regenerate below if unreadable.
  }

  const nextRelay = {
    id: 'local-relay-01',
    name: 'Local OmniFleet Relay',
    token: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
  }
  writeFileSync(relayStorePath, JSON.stringify(nextRelay, null, 2), 'utf8')
  return nextRelay
}

function loadRegistry() {
  try {
    if (!existsSync(registryPath)) return new Map()
    const items = JSON.parse(readFileSync(registryPath, 'utf8'))
    return new Map(items.map((runner) => [runner.id, runner]))
  } catch {
    return new Map()
  }
}

function saveRegistry() {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(registryPath, JSON.stringify(Array.from(runners.values()), null, 2), 'utf8')
}

function loadTasks() {
  try {
    if (!existsSync(taskStorePath)) return new Map()
    const items = JSON.parse(readFileSync(taskStorePath, 'utf8'))
    return new Map(items.map((task) => [`${task.runnerId}:${task.id}`, task]))
  } catch {
    return new Map()
  }
}

function saveTasks() {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(taskStorePath, JSON.stringify(Array.from(tasks.values()).slice(-200), null, 2), 'utf8')
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(data))
}

function unauthorized(res) {
  return json(res, 401, { error: 'Missing or invalid X-OmniFleet-Relay-Token header.' })
}

function isRelayAuthorized(req, url) {
  const token = req.headers['x-omnifleet-relay-token']
  const queryToken = url.searchParams.get('relayToken')
  return (typeof token === 'string' && token === relay.token) || queryToken === relay.token
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

function publicRunner(runner) {
  return {
    id: runner.id,
    name: runner.name,
    endpoint: runner.endpoint,
    status: runner.status,
    tools: runner.tools ?? [],
    projects: runner.projects ?? [],
    capabilities: runner.capabilities ?? [],
    registeredAt: runner.registeredAt,
    lastSeenAt: runner.lastSeenAt,
    lastProbeAt: runner.lastProbeAt ?? null,
    lastProbeOk: runner.lastProbeOk ?? false,
    lastProbeError: runner.lastProbeError ?? null,
  }
}

function publicTask(task) {
  return {
    id: task.id,
    runnerId: task.runnerId,
    runnerName: task.runnerName,
    description: task.description,
    tool: task.tool,
    status: task.status,
    createdAt: task.createdAt,
    retryOf: task.retryOf ?? null,
    updatedAt: task.updatedAt,
    routing: task.routing ?? null,
    result: task.result ?? null,
  }
}

function rememberTask(runner, task, metadata = {}) {
  const record = {
    id: task.id,
    runnerId: runner.id,
    runnerName: runner.name,
    description: task.description,
    tool: task.tool,
    status: task.status,
    createdAt: task.createdAt,
    retryOf: task.retryOf ?? null,
    updatedAt: new Date().toISOString(),
    routing: metadata.routing ?? tasks.get(`${runner.id}:${task.id}`)?.routing ?? null,
    result: task.result ?? null,
  }
  tasks.set(`${runner.id}:${task.id}`, record)
  saveTasks()
  return record
}

function updateTaskFromStateEvent(runner, taskId, event) {
  if (!event?.status) return
  const key = `${runner.id}:${taskId}`
  const existing = tasks.get(key)
  const record = {
    id: taskId,
    runnerId: runner.id,
    runnerName: runner.name,
    description: existing?.description ?? taskId,
    tool: existing?.tool ?? 'unknown',
    status: event.status,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    retryOf: existing?.retryOf ?? null,
    updatedAt: new Date().toISOString(),
    routing: existing?.routing ?? null,
    result: event.result ?? existing?.result ?? null,
  }
  tasks.set(key, record)
  saveTasks()
}

function runnerHeaders(req) {
  const token = req.headers['x-omnifleet-token']
  return {
    'Content-Type': 'application/json',
    ...(typeof token === 'string' ? { 'X-OmniFleet-Token': token } : {}),
  }
}

function findRunner(id) {
  const runner = runners.get(id)
  if (!runner) return null
  return runner
}

async function probeRunner(runner) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)

  try {
    const response = await fetch(`${runner.endpoint}/api/health`, { signal: controller.signal })
    runner.lastProbeAt = new Date().toISOString()
    runner.lastProbeOk = response.ok
    runner.lastProbeError = response.ok ? null : `HTTP ${response.status}`
  } catch (error) {
    runner.lastProbeAt = new Date().toISOString()
    runner.lastProbeOk = false
    runner.lastProbeError = error instanceof Error ? error.message : 'probe failed'
  } finally {
    clearTimeout(timeout)
    saveRegistry()
  }
}

function runnerStatus(runner) {
  const seenRecently = Date.now() - Date.parse(runner.lastSeenAt) < 45000
  if (runner.lastProbeOk) return 'online'
  return seenRecently ? 'stale' : 'offline'
}

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function routeRunner(body) {
  const candidates = Array.from(runners.values())
    .map((runner) => ({ ...runner, status: runnerStatus(runner) }))
  const online = candidates.filter((runner) => runner.status === 'online')

  const evaluated = online
    .map((runner) => {
      const tools = runner.tools ?? []
      const projects = runner.projects ?? []
      const toolMatch = body.tool ? tools.includes(body.tool) : true
      const projectMatch = body.projectId
        ? projects.some((project) => normalizeName(project) === normalizeName(body.projectId))
        : true
      const score = (toolMatch ? 10 : 0) + (projectMatch ? 10 : 0) + (runner.lastProbeOk ? 2 : 0)
      return {
        runner,
        score,
        toolMatch,
        projectMatch,
        reason: `online runner matched project=${body.projectId ?? 'any'} and tool=${body.tool ?? 'any'}`,
      }
    })

  const scored = evaluated
    .filter((item) => item.toolMatch && item.projectMatch)
    .sort((a, b) => b.score - a.score)

  const selected = scored[0]
  if (!selected) {
    return {
      runner: null,
      diagnostics: {
        requestedProject: body.projectId ?? null,
        requestedTool: body.tool ?? null,
        totalRunners: candidates.length,
        onlineRunners: online.length,
        evaluated: evaluated.map((item) => ({
          runnerId: item.runner.id,
          runnerName: item.runner.name,
          status: item.runner.status,
          tools: item.runner.tools ?? [],
          projects: item.runner.projects ?? [],
          toolMatch: item.toolMatch,
          projectMatch: item.projectMatch,
        })),
      },
    }
  }
  return {
    runner: selected.runner,
    decision: {
      mode: 'auto',
      selectedRunnerId: selected.runner.id,
      selectedRunnerName: selected.runner.name,
      score: selected.score,
      reason: selected.reason,
      candidateCount: candidates.length,
      decidedAt: new Date().toISOString(),
    },
  }
}

function startProbeLoop() {
  const run = () => {
    for (const runner of runners.values()) probeRunner(runner)
  }
  run()
  setInterval(run, Number(process.env.OMNIFLEET_RELAY_PROBE_INTERVAL_MS ?? 15000))
}

async function proxyJson(req, res, runner, path, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OMNIFLEET_RELAY_PROXY_TIMEOUT_MS ?? 10000))
  let response
  try {
    response = await fetch(`${runner.endpoint}${path}`, {
      method: options.method ?? req.method,
      headers: runnerHeaders(req),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Runner proxy request failed'
    json(res, 502, { error: message, runnerId: runner.id, endpoint: runner.endpoint })
    return { ok: false, status: 502, data: null }
  } finally {
    clearTimeout(timeout)
  }
  const text = await response.text()
  res.writeHead(response.status, {
    'Content-Type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(text)
  try {
    return { ok: response.ok, status: response.status, data: text ? JSON.parse(text) : null }
  } catch {
    return { ok: response.ok, status: response.status, data: null }
  }
}

async function proxyEvents(req, res, runner, taskId) {
  const token = req.headers['x-omnifleet-token'] ?? new URL(req.url, `http://${req.headers.host}`).searchParams.get('token')
  const eventUrl = `${runner.endpoint}/api/tasks/${taskId}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`
  const response = await fetch(eventUrl)

  if (!response.ok || !response.body) {
    return json(res, response.status, { error: 'Unable to connect to runner event stream' })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  req.on('close', () => reader.cancel().catch(() => undefined))

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6))
          if (event.type === 'state') updateTaskFromStateEvent(runner, taskId, event)
        } catch {
          // Ignore malformed SSE data lines; the raw stream is still proxied.
        }
      }
    }
  }
  res.end()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'OPTIONS') return json(res, 204, {})

  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, role: 'relay', tokenRequired: true, relay: { id: relay.id, name: relay.name } })
    if (url.pathname.startsWith('/api/') && !isRelayAuthorized(req, url)) return unauthorized(res)

    if (url.pathname === '/api/runners' && req.method === 'GET') {
      const items = Array.from(runners.values())
        .map((runner) => ({
          ...runner,
          status: runnerStatus(runner),
        }))
        .map(publicRunner)
      return json(res, 200, items)
    }

    if (url.pathname === '/api/runners/register' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.id || !body.name || !body.endpoint) return json(res, 400, { error: 'id, name, and endpoint are required' })

      const previous = runners.get(body.id)
      const runner = {
        id: String(body.id),
        name: String(body.name),
        endpoint: String(body.endpoint),
        status: 'online',
        tools: Array.isArray(body.tools) ? body.tools : [],
        projects: Array.isArray(body.projects) ? body.projects : [],
        capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
        registeredAt: previous?.registeredAt ?? new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastProbeAt: previous?.lastProbeAt ?? null,
        lastProbeOk: previous?.lastProbeOk ?? false,
        lastProbeError: previous?.lastProbeError ?? null,
      }
      runners.set(runner.id, runner)
      saveRegistry()
      probeRunner(runner)
      return json(res, 200, publicRunner(runner))
    }

    const runnerDeleteMatch = url.pathname.match(/^\/api\/runners\/([^/]+)$/)
    if (runnerDeleteMatch && req.method === 'DELETE') {
      const deleted = runners.delete(runnerDeleteMatch[1])
      saveRegistry()
      return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Runner not found' })
    }

    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const items = Array.from(tasks.values())
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 100)
        .map(publicTask)
      return json(res, 200, items)
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readBody(req)
      const runner = findRunner(body.runnerId)
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      const proxied = await proxyJson(req, res, runner, '/api/tasks', { method: 'POST', body })
      if (proxied.ok && proxied.data?.id) rememberTask(runner, proxied.data)
      return
    }

    if (url.pathname === '/api/tasks/route' && req.method === 'POST') {
      const body = await readBody(req)
      const routed = routeRunner(body)
      if (!routed?.runner) return json(res, 409, { error: 'No online runner matches the requested project and tool.', diagnostics: routed?.diagnostics ?? null })
      const { runner, decision } = routed
      const routedBody = { ...body, runnerId: runner.id }
      const proxied = await proxyJson(req, res, runner, '/api/tasks', { method: 'POST', body: routedBody })
      if (proxied.ok && proxied.data?.id) rememberTask(runner, proxied.data, { routing: decision })
      return
    }

    const taskListMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)
    if (taskListMatch && req.method === 'GET') {
      const runner = findRunner(taskListMatch[1])
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      return proxyJson(req, res, runner, '/api/tasks')
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)$/)
    if (taskMatch && req.method === 'GET') {
      const runner = findRunner(taskMatch[1])
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      return proxyJson(req, res, runner, `/api/tasks/${taskMatch[2]}`)
    }

    const approveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/approve$/)
    if (approveMatch && req.method === 'POST') {
      const runner = findRunner(approveMatch[1])
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      const proxied = await proxyJson(req, res, runner, `/api/tasks/${approveMatch[2]}/approve`, { method: 'POST' })
      if (proxied.ok && proxied.data?.id) rememberTask(runner, proxied.data)
      return
    }

    const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/cancel$/)
    if (cancelMatch && req.method === 'POST') {
      const runner = findRunner(cancelMatch[1])
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      const proxied = await proxyJson(req, res, runner, `/api/tasks/${cancelMatch[2]}/cancel`, { method: 'POST' })
      if (proxied.ok && proxied.data?.id) rememberTask(runner, proxied.data)
      return
    }

    const retryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/retry$/)
    if (retryMatch && req.method === 'POST') {
      const runner = findRunner(retryMatch[1])
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      const proxied = await proxyJson(req, res, runner, `/api/tasks/${retryMatch[2]}/retry`, { method: 'POST' })
      if (proxied.ok && proxied.data?.id) rememberTask(runner, proxied.data)
      return
    }

    const exportMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/export$/)
    if (exportMatch && req.method === 'GET') {
      const runner = findRunner(exportMatch[1])
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      return proxyJson(req, res, runner, `/api/tasks/${exportMatch[2]}/export`)
    }

    const applyMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/apply$/)
    if (applyMatch && req.method === 'POST') {
      const runner = findRunner(applyMatch[1])
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      const proxied = await proxyJson(req, res, runner, `/api/tasks/${applyMatch[2]}/apply`, { method: 'POST' })
      if (proxied.ok && proxied.data?.id) rememberTask(runner, proxied.data)
      return
    }

    const eventMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/events$/)
    if (eventMatch && req.method === 'GET') {
      const runner = findRunner(eventMatch[1])
      if (!runner) return json(res, 404, { error: 'Runner not found' })
      return proxyEvents(req, res, runner, eventMatch[2])
    }

    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
})

server.listen(port, () => {
  console.log(`OmniFleet relay listening on http://localhost:${port}`)
  startProbeLoop()
})
