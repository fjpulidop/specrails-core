import assert from 'node:assert/strict'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Annotation, END, getWriter, START, StateGraph } from '@langchain/langgraph'
import { SpikeSqliteSaver } from './sqlite-saver.mjs'

const PHASES = ['architect', 'developer', 'fixer', 'verify', 'reviewer', 'archive']
const State = Annotation.Root({ completed: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }) })
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const fixturePayload = node => node === 'verify' ? { type: 'verification-output', nodePath: node, text: 'fixture verification passed' }
  : { type: 'agent-event', role: node, nodePath: node, event: { kind: 'text', text: 'fixture ' + node } }

function graphFor(saver) {
  const builder = new StateGraph(State)
  for (const [index, node] of PHASES.entries()) {
    builder.addNode(node, async () => {
      getWriter()?.({ ...fixturePayload(node), producedAt: performance.now() })
      return { completed: [node] }
    })
    builder.addEdge(index ? PHASES[index - 1] : START, node)
  }
  return builder.addEdge(PHASES.at(-1), END).compile({ checkpointer: saver })
}

async function measureStream(directory, label, delayMs) {
  const commits = new Map(), terminal = [], chunks = [], latencies = []
  class ObservedSaver extends SpikeSqliteSaver {
    async putWrites(...args) { if (delayMs) await delay(delayMs); return super.putWrites(...args) }
  }
  const saver = new ObservedSaver(path.join(directory, label, 'run.sqlite'), { observe(event) {
    if (event.type !== 'writes-commit') return
    for (const node of event.completed) {
      commits.set(node, event.at)
      // This is a fixture terminal projection; durable event sequence/attempt IDs
      // still need the production ledger design before C3 can use it.
      const present = saver.db.prepare('SELECT 1 FROM node_results WHERE node_id=?').get(node)
      assert.ok(present, 'Terminal observer must see committed evidence')
      terminal.push({ type: 'workflow-event', event: { type: 'step_succeeded', nodePath: node }, at: performance.now() })
    }
  } })
  try {
    const started = performance.now()
    for await (const chunk of await graphFor(saver).stream({}, { configurable: { thread_id: label }, durability: 'sync', streamMode: ['updates', 'custom'], subgraphs: true })) {
      const [, mode, value] = chunk
      const arrived = performance.now()
      const nodes = mode === 'updates' ? Object.keys(value).filter(node => PHASES.includes(node)) : []
      chunks.push({ mode, bytes: bytes(chunk), arrived, nodes, committedAtArrival: nodes.every(node => commits.has(node)) })
      if (mode === 'custom') latencies.push(arrived - value.producedAt)
    }
    assert.equal(terminal.length, PHASES.length)
    assert.equal(chunks.filter(chunk => chunk.mode === 'custom').length, PHASES.length)
    const updates = chunks.filter(chunk => chunk.nodes.length)
    assert.equal(updates.length, PHASES.length)
    if (delayMs) assert.ok(updates.some(chunk => !chunk.committedAtArrival), 'A delayed saver demonstrates updates are not post-commit notifications')
    return { durationMs: performance.now() - started, saverDelayMs: delayMs, updates: updates.length,
      updatesBeforeCommit: updates.filter(chunk => !chunk.committedAtArrival).length,
      customEvents: latencies.length, meanCustomLatencyMs: mean(latencies), maxCustomLatencyMs: Math.max(...latencies),
      streamBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), committedTerminalEvents: terminal.length,
      committedTerminalBytes: terminal.reduce((sum, event) => sum + bytes(event), 0), postCommitProjectionVerified: true }
  } finally { saver.close() }
}

async function measureEventStream(directory) {
  const saver = new SpikeSqliteSaver(path.join(directory, 'stream-events', 'run.sqlite'))
  const counts = {}, terminal = []
  let volume = 0
  try {
    const started = performance.now()
    for await (const event of graphFor(saver).streamEvents({}, { configurable: { thread_id: 'stream-events' }, durability: 'sync', version: 'v2' })) {
      volume += bytes(event)
      counts[event.event] = (counts[event.event] ?? 0) + 1
      if (event.event === 'on_chain_end' && PHASES.includes(event.name)) terminal.push({ node: event.name, committed: !!saver.db.prepare('SELECT 1 FROM node_results WHERE node_id=?').get(event.name) })
    }
    assert.equal(terminal.length, PHASES.length)
    return { durationMs: performance.now() - started, bytes: volume, events: counts, nodeEndsBeforeCommit: terminal.filter(event => !event.committed).length }
  } finally { saver.close() }
}

async function legacyCallbacks(directory) {
  const { runWorkflow } = await import('../../../../dist/agent-runtime/workflow.js')
  const events = [], spans = [], progress = []
  const nodes = Object.fromEntries(PHASES.map((node, index) => [node, {
    effect: 'read', ends: index + 1 < PHASES.length ? [PHASES[index + 1]] : [],
    async run() { progress.push(fixturePayload(node)); return { status: 'succeeded', update: { completed: [node] }, usage: { costUsd: 0, inputTokens: 10, outputTokens: 1 } } },
  }]))
  const started = performance.now()
  const state = await runWorkflow({ directory: path.join(directory, 'legacy'), runId: 'legacy-fixture', input: null,
    workflow: { id: 'c1-fixture', version: '1', schema: State, entry: PHASES[0], nodes },
    onEvent: event => { events.push(event) }, onSpan: span => { spans.push(span) } })
  assert.equal(state.status, 'succeeded')
  assert.equal(events.filter(event => event.type === 'step_succeeded').length, PHASES.length)
  return { durationMs: performance.now() - started, workflowEvents: events.length, spans: spans.length, progressEvents: progress.length,
    bytes: bytes(events) + bytes(spans) + bytes(progress), usage: state.usage }
}

export async function streamingProbe(directory) {
  return { fixture: 'same six deterministic phase functions: existing runWorkflow callbacks vs experimental StateGraph; no actual provider or implementation acceptance claim',
    natural: await measureStream(directory, 'stream-natural', 0), delayed: await measureStream(directory, 'stream-delayed', 5),
    streamEvents: await measureEventStream(directory), legacy: await legacyCallbacks(directory),
    decision: 'Hybrid: custom/writer for transient progress, transactional pending-write ledger observer for durable lifecycle; raw updates and chain-end are not commit acknowledgements' }
}
