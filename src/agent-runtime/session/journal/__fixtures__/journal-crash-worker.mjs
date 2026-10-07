// Appends 3-event batches as fast as possible and SIGKILLs itself mid-stream.
// Uses the compiled journal (run `npm run build` first), like the checkpoint crash tests.
import { SqliteSessionJournal } from '../../../../../dist/agent-runtime/session/journal/sqlite-journal.js'

const [home] = process.argv.slice(2)
const journal = await SqliteSessionJournal.open({ scope: 'crash', owner: `worker-${process.pid}`, home, heartbeat: false })
const at = new Date().toISOString()
journal.createSession({ sessionId: 's1', driver: 'claude', cwd: '/', createdAt: at, metadata: {} })
const policy = { subagents: 'enabled', onSubagentsSettled: 'provider-native', tools: { mode: 'default' }, permissions: 'bypass', mcp: { servers: [], inheritUserScope: false }, limits: { idleMs: 1000, stallMs: 1000, backgroundMaxMs: 1000, turnInactivityMs: 1000, maxSettleHandoffs: 0, settleDebounceMs: 0 } }
journal.append('s1', [
  { type: 'session.opened', driver: 'claude', model: 'm', policy, resumed: false, providerSessionRef: null, at },
  { type: 'provider.diagnostic', level: 'info', code: 'start', message: 'x', at },
  { type: 'provider.diagnostic', level: 'info', code: 'start', message: 'y', at },
])
let batches = 0
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 150)
for (;;) {
  journal.append('s1', [0, 1, 2].map((index) => ({ type: 'provider.diagnostic', level: 'info', code: `b${batches}`, message: String(index), at })))
  batches += 1
  if (batches % 50 === 0) await new Promise((resolve) => setImmediate(resolve))
}
