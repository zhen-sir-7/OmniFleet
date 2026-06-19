import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const stateDir = resolve(root, '.omnifleet')
const registryPath = resolve(stateDir, 'relay-runners.json')
const port = Number(process.env.OMNIFLEET_RELAY_PORT ?? 8790)
const runners = loadRegistry()

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
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'OPTIONS') return json(res, 204, {})

  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, role: 'relay' })

    if (url.pathname === '/api/runners' && req.method === 'GET') {
      const now = Date.now()
      const items = Array.from(runners.values())
        .map((runner) => ({
          ...runner,
          status: now - Date.parse(runner.lastSeenAt) < 45000 ? 'online' : 'stale',
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
      }
      runners.set(runner.id, runner)
      saveRegistry()
      return json(res, 200, publicRunner(runner))
    }

    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
})

server.listen(port, () => {
  console.log(`OmniFleet relay listening on http://localhost:${port}`)
})
