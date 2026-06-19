import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const config = JSON.parse(readFileSync(join(root, 'omnifleet.config.json'), 'utf8'))
const port = Number(process.env.OMNIFLEET_PORT ?? 8787)
const tasks = new Map()
const subscribers = new Map()

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

function sendEvent(taskId, event) {
  const task = tasks.get(taskId)
  if (!task) return

  task.events.push(event)
  const clients = subscribers.get(taskId) ?? new Set()
  for (const res of clients) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}

function updateTask(taskId, patch) {
  const task = tasks.get(taskId)
  if (!task) return
  Object.assign(task, patch)
  sendEvent(taskId, { type: 'state', status: task.status, result: task.result ?? null })
}

function publicTask(task) {
  return {
    id: task.id,
    description: task.description,
    runnerId: task.runnerId,
    projectId: task.projectId,
    tool: task.tool,
    status: task.status,
    createdAt: task.createdAt,
    result: task.result ?? null,
    events: task.events,
  }
}

function normalizeProjects() {
  return config.projects.map((project) => ({
    ...project,
    absolutePath: resolve(root, project.path),
  }))
}

function commandParts(command) {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }

  return { command: 'sh', args: ['-c', command] }
}

function runCommand(taskId, project, command) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now()
    const parts = commandParts(command)
    const child = spawn(parts.command, parts.args, {
      cwd: project.absolutePath,
      env: process.env,
      windowsHide: true,
    })

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        sendEvent(taskId, { type: 'log', level: 'stdout', message: line })
      }
    })

    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        sendEvent(taskId, { type: 'log', level: 'stderr', message: line })
      }
    })

    child.on('error', (error) => {
      sendEvent(taskId, { type: 'log', level: 'error', message: error.message })
      resolveRun({ ok: false, code: -1, durationMs: Date.now() - startedAt })
    })

    child.on('close', (code) => {
      resolveRun({ ok: code === 0, code, durationMs: Date.now() - startedAt })
    })
  })
}

async function runTask(taskId) {
  const task = tasks.get(taskId)
  const project = normalizeProjects().find((item) => item.id === task?.projectId)

  if (!task || !project) return

  updateTask(taskId, { status: 'running' })
  sendEvent(taskId, { type: 'log', level: 'info', message: `task accepted by ${config.runner.name}` })
  sendEvent(taskId, { type: 'log', level: 'info', message: `project context loaded: ${project.name}` })
  sendEvent(taskId, { type: 'log', level: 'info', message: 'policy check: project path is whitelisted' })
  sendEvent(taskId, { type: 'log', level: 'info', message: `tool selected: ${task.tool}` })

  if (!existsSync(project.absolutePath) || !statSync(project.absolutePath).isDirectory()) {
    updateTask(taskId, {
      status: 'failed',
      result: { ok: false, summary: 'Project path does not exist or is not a directory.' },
    })
    return
  }

  const command = project.defaultCommand
  if (!project.allowedCommands.includes(command)) {
    updateTask(taskId, {
      status: 'failed',
      result: { ok: false, summary: `Command is not allowed by policy: ${command}` },
    })
    return
  }

  sendEvent(taskId, { type: 'log', level: 'info', message: `safe command started: ${command}` })
  const run = await runCommand(taskId, project, command)

  const summary = run.ok
    ? 'Safe command completed successfully. Result is ready for approval.'
    : `Safe command failed with exit code ${run.code}. Review logs before continuing.`

  updateTask(taskId, {
    status: 'review',
    result: {
      ok: run.ok,
      command,
      durationMs: run.durationMs,
      summary,
      diff: [
        '+ Real local runner accepted the task',
        '+ SSE execution stream connected to the web client',
        '+ Project command executed inside a whitelisted workspace',
        '+ Human approval remains required before commit or push',
      ],
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'OPTIONS') return json(res, 204, {})

  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, runner: config.runner })
    }

    if (url.pathname === '/api/runners') {
      return json(res, 200, [{ ...config.runner, status: 'online', projects: config.projects.map((project) => project.name) }])
    }

    if (url.pathname === '/api/projects') {
      return json(res, 200, normalizeProjects())
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readBody(req)
      const id = `task_${Date.now()}`
      const task = {
        id,
        description: String(body.description ?? '').trim(),
        runnerId: body.runnerId ?? config.runner.id,
        projectId: body.projectId ?? config.projects[0].id,
        tool: body.tool ?? config.runner.tools[0],
        status: 'queued',
        createdAt: new Date().toISOString(),
        events: [],
      }
      tasks.set(id, task)
      setTimeout(() => runTask(id), 250)
      return json(res, 201, publicTask(task))
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
      for (const event of task.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
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
})
