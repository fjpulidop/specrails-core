import http from 'http'
import path from 'path'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { WsMessage } from './types'
import { createHooksRouter, getPhaseStates } from './hooks'
import { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError } from './queue-manager'
import { initDb, listJobs, getJob, getJobEvents, getStats } from './db'
import { getConfig, fetchIssues } from './config'

// Read package.json version once at startup
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../package.json') as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// Resolve project name: env var > CLI flag > git root basename > cwd parent
function resolveProjectName(): string {
  if (process.env.SPECRAILS_PROJECT_NAME) {
    return process.env.SPECRAILS_PROJECT_NAME
  }
  // The web-manager lives at <project>/specrails/web-manager/
  // Walk up two levels to find the project root
  const cwd = process.cwd()
  const parentDir = path.basename(path.resolve(cwd, '../..'))
  const immediateParent = path.basename(path.resolve(cwd, '..'))
  // If we're inside specrails/web-manager, use the grandparent directory name
  if (immediateParent === 'specrails') {
    return parentDir
  }
  return path.basename(cwd)
}

// Parse CLI args
let projectName = resolveProjectName()
let port = 4200

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--project' && process.argv[i + 1]) {
    projectName = process.argv[++i]
  } else if (process.argv[i] === '--port' && process.argv[i + 1]) {
    port = parseInt(process.argv[++i], 10)
  }
}

const app = express()
app.use(express.json())

const db = initDb(path.join(process.cwd(), 'data', 'jobs.sqlite'))

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

const clients = new Set<WebSocket>()

function broadcast(msg: WsMessage): void {
  const data = JSON.stringify(msg)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

const queueManager = new QueueManager(broadcast, db)

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws)

  const initMsg: WsMessage = {
    type: 'init',
    projectName,
    phases: getPhaseStates(),
    logBuffer: queueManager.getLogBuffer().slice(-500),
    recentJobs: listJobs(db, { limit: 10 }).jobs,
    queue: {
      jobs: queueManager.getJobs(),
      activeJobId: queueManager.getActiveJobId(),
      paused: queueManager.isPaused(),
    },
  }
  ws.send(JSON.stringify(initMsg))

  ws.on('close', () => {
    clients.delete(ws)
  })
})

// Routes
app.use('/hooks', createHooksRouter(broadcast, db, {
  get current() { return queueManager.getActiveJobId() },
  set current(_: string | null) { /* managed by QueueManager */ },
}))

app.post('/api/spawn', (req, res) => {
  const { command } = req.body ?? {}
  if (!command || typeof command !== 'string' || !command.trim()) {
    res.status(400).json({ error: 'command is required' })
    return
  }

  try {
    const job = queueManager.enqueue(command)
    const position = job.queuePosition ?? 0
    res.status(202).json({ jobId: job.id, position })
  } catch (err) {
    if (err instanceof ClaudeNotFoundError) {
      res.status(400).json({ error: err.message })
    } else {
      console.error('[spawn] unexpected error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
})

app.get('/api/state', (_req, res) => {
  res.json({
    projectName,
    phases: getPhaseStates(),
    busy: queueManager.getActiveJobId() !== null,
    currentJobId: queueManager.getActiveJobId(),
    version: PKG_VERSION,
  })
})

app.delete('/api/jobs/:id', (req, res) => {
  try {
    const result = queueManager.cancel(req.params.id)
    res.json({ ok: true, status: result })
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      res.status(404).json({ error: 'Job not found' })
    } else if (err instanceof JobAlreadyTerminalError) {
      res.status(409).json({ error: 'Job is already in terminal state' })
    } else {
      res.status(500).json({ error: 'Internal server error' })
    }
  }
})

app.post('/api/queue/pause', (_req, res) => {
  queueManager.pause()
  res.json({ ok: true, paused: true })
})

app.post('/api/queue/resume', (_req, res) => {
  queueManager.resume()
  res.json({ ok: true, paused: false })
})

app.put('/api/queue/reorder', (req, res) => {
  const { jobIds } = req.body ?? {}
  if (!Array.isArray(jobIds)) {
    res.status(400).json({ error: 'jobIds must be an array' })
    return
  }
  try {
    queueManager.reorder(jobIds)
    res.json({ ok: true, queue: jobIds })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.get('/api/queue', (_req, res) => {
  res.json({
    jobs: queueManager.getJobs(),
    paused: queueManager.isPaused(),
    activeJobId: queueManager.getActiveJobId(),
  })
})

app.get('/api/jobs', (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200)
  const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0
  const status = req.query.status as string | undefined
  const from = req.query.from as string | undefined
  const to = req.query.to as string | undefined
  const result = listJobs(db, { limit, offset, status, from, to })
  res.json(result)
})

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(db, req.params.id)
  if (!job) { res.status(404).json({ error: 'Job not found' }); return }
  const events = getJobEvents(db, req.params.id)
  res.json({ job, events })
})

app.get('/api/stats', (_req, res) => {
  res.json(getStats(db))
})

app.get('/api/config', (_req, res) => {
  try {
    const config = getConfig(process.cwd(), db, projectName)
    res.json(config)
  } catch (err) {
    console.error('[config] error:', err)
    res.status(500).json({ error: 'Failed to read config' })
  }
})

app.post('/api/config', (req, res) => {
  const { active, labelFilter } = req.body ?? {}
  try {
    if (active !== undefined) {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.active_tracker', ?)`).run(active ?? '')
    }
    if (labelFilter !== undefined) {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.label_filter', ?)`).run(labelFilter ?? '')
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[config] persist error:', err)
    res.status(500).json({ error: 'Failed to persist config' })
  }
})

app.get('/api/issues', (_req, res) => {
  try {
    const config = getConfig(process.cwd(), db, projectName)
    const tracker = config.issueTracker.active
    if (!tracker) {
      res.status(503).json({ error: 'No issue tracker configured', trackers: config.issueTracker })
      return
    }

    const search = _req.query.search as string | undefined
    const label = _req.query.label as string | undefined
    const issues = fetchIssues(tracker, { search, label, repo: config.project.repo })
    res.json(issues)
  } catch (err) {
    console.error('[issues] error:', err)
    res.status(500).json({ error: 'Failed to fetch issues' })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`specrails web manager running on http://127.0.0.1:${port}`)
})
