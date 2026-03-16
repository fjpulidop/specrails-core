import http from 'http'
import path from 'path'
import fs from 'fs'
import os from 'os'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { WsMessage } from './types'
import { ProjectRegistry } from './project-registry'
import { createHubRouter } from './hub-router'
import { createProjectRouter } from './project-router'
import { createHooksRouter, getPhaseStates, getPhaseDefinitions } from './hooks'
import { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError } from './queue-manager'
import { initDb, listJobs, getJob, getJobEvents, getStats, purgeJobs,
  createConversation, listConversations, getConversation,
  deleteConversation, updateConversation, addMessage, getMessages } from './db'
import { ChatManager } from './chat-manager'
import type { ChatConversationRow } from './types'
import { getConfig, fetchIssues } from './config'
import { getAnalytics } from './analytics'
import { v4 as uuidv4 } from 'uuid'

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

// ─── Mode detection ───────────────────────────────────────────────────────────

// Hub mode: started with --hub flag or SPECRAILS_HUB=1 env var
const isHubMode = process.argv.includes('--hub') || process.env.SPECRAILS_HUB === '1'

// ─── Resolve project name (legacy single-project mode) ────────────────────────

function resolveProjectName(): string {
  if (process.env.SPECRAILS_PROJECT_NAME) {
    return process.env.SPECRAILS_PROJECT_NAME
  }
  const cwd = process.cwd()
  const parentDir = path.basename(path.resolve(cwd, '../..'))
  const immediateParent = path.basename(path.resolve(cwd, '..'))
  if (immediateParent === 'specrails') {
    return parentDir
  }
  return path.basename(cwd)
}

// ─── Parse CLI args ───────────────────────────────────────────────────────────

let projectName = resolveProjectName()
let port = 4200

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--project' && process.argv[i + 1]) {
    projectName = process.argv[++i]
  } else if (process.argv[i] === '--port' && process.argv[i + 1]) {
    port = parseInt(process.argv[++i], 10)
  }
}

// ─── PID file management ──────────────────────────────────────────────────────

const PID_DIR = path.join(os.homedir(), '.specrails')
const PID_FILE = path.join(PID_DIR, 'web-manager.pid')

function writePidFile(): void {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true })
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8')
  } catch {
    // Non-fatal
  }
}

function removePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE)
  } catch {
    // Non-fatal
  }
}

// ─── Express + WebSocket setup ────────────────────────────────────────────────

const app = express()
app.use(express.json())

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

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

// ─── Hub mode ─────────────────────────────────────────────────────────────────

if (isHubMode) {
  const registry = new ProjectRegistry(broadcast)
  registry.loadAll()

  // Hub-level routes
  app.use('/api/hub', createHubRouter(registry, broadcast))

  // Per-project routes under /api/projects/:projectId/*
  app.use('/api/projects', createProjectRouter(registry))

  // Return 410 Gone for old per-project hook endpoint in hub mode
  app.post('/hooks/events', (_req, res) => {
    res.status(410).json({
      error: 'In hub mode, use /api/projects/:projectId/hooks/events',
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws)

    // Send hub state init
    const projects = registry.listContexts().map((ctx) => ctx.project)
    ws.send(JSON.stringify({
      type: 'hub.projects',
      projects,
      timestamp: new Date().toISOString(),
    }))

    ws.on('close', () => {
      clients.delete(ws)
    })
  })

} else {
  // ─── Single-project (legacy) mode ─────────────────────────────────────────

  const db = initDb(path.join(process.cwd(), 'data', 'jobs.sqlite'))
  const queueManager = new QueueManager(broadcast, db)
  const chatManager = new ChatManager(broadcast, db)

  try {
    const initialConfig = getConfig(process.cwd(), db, projectName)
    queueManager.setCommands(initialConfig.commands)
  } catch {
    console.warn('[init] failed to load commands for phase resolution')
  }

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws)

    const initMsg: WsMessage = {
      type: 'init',
      projectName,
      phases: getPhaseStates(),
      phaseDefinitions: getPhaseDefinitions(),
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
    const phaseDefinitions = queueManager.phasesForCommand(job.command)
    res.json({ job, events, phaseDefinitions })
  })

  app.delete('/api/jobs', (req, res) => {
    try {
      const { from, to } = req.body ?? {}
      const deleted = purgeJobs(db, { from, to })
      res.json({ ok: true, deleted })
    } catch (err) {
      console.error('[purge] error:', err)
      res.status(500).json({ error: 'Failed to purge jobs' })
    }
  })

  app.get('/api/stats', (_req, res) => {
    res.json(getStats(db))
  })

  app.get('/api/analytics', (req, res) => {
    const period = (req.query.period as string) || '7d'
    const from = req.query.from as string | undefined
    const to = req.query.to as string | undefined
    const validPeriods = ['7d', '30d', '90d', 'all', 'custom']
    if (!validPeriods.includes(period)) {
      res.status(400).json({ error: 'Invalid period. Must be one of: 7d, 30d, 90d, all, custom' })
      return
    }
    if (period === 'custom' && (!from || !to)) {
      res.status(400).json({ error: 'from and to are required for custom period' })
      return
    }
    try {
      res.json(getAnalytics(db, { period: period as any, from, to }))
    } catch (err) {
      console.error('[analytics] error:', err)
      res.status(500).json({ error: 'Failed to compute analytics' })
    }
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

  // Chat routes
  app.get('/api/chat/conversations', (_req, res) => {
    const conversations = listConversations(db)
    res.json({ conversations })
  })

  app.post('/api/chat/conversations', (req, res) => {
    const model = (req.body?.model as string | undefined) ?? 'claude-sonnet-4-5'
    const id = uuidv4()
    createConversation(db, { id, model })
    const conversation = getConversation(db, id) as ChatConversationRow
    res.status(201).json({ conversation })
  })

  app.get('/api/chat/conversations/:id', (req, res) => {
    const conversation = getConversation(db, req.params.id)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const messages = getMessages(db, req.params.id)
    res.json({ conversation, messages })
  })

  app.delete('/api/chat/conversations/:id', (req, res) => {
    const conversation = getConversation(db, req.params.id)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    deleteConversation(db, req.params.id)
    res.json({ ok: true })
  })

  app.patch('/api/chat/conversations/:id', (req, res) => {
    const conversation = getConversation(db, req.params.id)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const { title, model } = req.body ?? {}
    const patch: { title?: string; model?: string } = {}
    if (title !== undefined) patch.title = title
    if (model !== undefined) patch.model = model
    updateConversation(db, req.params.id, patch)
    const updated = getConversation(db, req.params.id) as ChatConversationRow
    res.json({ ok: true, conversation: updated })
  })

  app.get('/api/chat/conversations/:id/messages', (req, res) => {
    const conversation = getConversation(db, req.params.id)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const messages = getMessages(db, req.params.id)
    res.json({ messages })
  })

  app.post('/api/chat/conversations/:id/messages', async (req, res) => {
    const conversation = getConversation(db, req.params.id)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const text = req.body?.text as string | undefined
    if (!text || !text.trim()) { res.status(400).json({ error: 'text is required' }); return }
    if (chatManager.isActive(req.params.id)) {
      res.status(409).json({ error: 'CONVERSATION_BUSY' }); return
    }
    res.status(202).json({ ok: true })
    chatManager.sendMessage(req.params.id, text.trim()).catch((err) => {
      console.error('[chat] sendMessage error:', err)
    })
  })

  app.delete('/api/chat/conversations/:id/messages/stream', (req, res) => {
    if (!chatManager.isActive(req.params.id)) {
      res.status(404).json({ error: 'No active stream for this conversation' }); return
    }
    chatManager.abort(req.params.id)
    res.json({ ok: true })
  })
}

// ─── Start server ─────────────────────────────────────────────────────────────

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[error] Port ${port} is already in use. Is another web-manager instance running?`)
    console.error(`[error] Try stopping it first: srm hub stop`)
    process.exit(1)
  }
  throw err
})

server.listen(port, '127.0.0.1', () => {
  const mode = isHubMode ? 'hub mode' : 'single-project mode'
  console.log(`specrails web manager (${mode}) running on http://127.0.0.1:${port}`)
  writePidFile()
})

// ─── Clean shutdown ───────────────────────────────────────────────────────────

function shutdown(): void {
  removePidFile()
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
