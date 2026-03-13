import http from 'http'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { WsMessage } from './types'
import { ClaudeNotFoundError, SpawnBusyError } from './types'
import { createHooksRouter, getPhaseStates, resetPhases } from './hooks'
import { spawnClaude, isSpawnActive, getLogBuffer } from './spawner'

// Parse CLI args
let projectName = 'specrails'
let port = 3001

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--project' && process.argv[i + 1]) {
    projectName = process.argv[++i]
  } else if (process.argv[i] === '--port' && process.argv[i + 1]) {
    port = parseInt(process.argv[++i], 10)
  }
}

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

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws)

  const initMsg: WsMessage = {
    type: 'init',
    projectName,
    phases: getPhaseStates(),
    logBuffer: getLogBuffer().slice(-500),
  }
  ws.send(JSON.stringify(initMsg))

  ws.on('close', () => {
    clients.delete(ws)
  })
})

// Routes
app.use('/hooks', createHooksRouter(broadcast))

app.post('/api/spawn', (req, res) => {
  const { command } = req.body ?? {}
  if (!command || typeof command !== 'string' || !command.trim()) {
    res.status(400).json({ error: 'command is required' })
    return
  }

  try {
    const handle = spawnClaude(
      command,
      broadcast,
      () => resetPhases(broadcast)
    )
    res.json({ processId: handle.processId })
  } catch (err) {
    if (err instanceof ClaudeNotFoundError) {
      res.status(400).json({ error: err.message })
    } else if (err instanceof SpawnBusyError) {
      res.status(409).json({ error: err.message })
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
    busy: isSpawnActive(),
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`specrails web manager running on http://127.0.0.1:${port}`)
})
