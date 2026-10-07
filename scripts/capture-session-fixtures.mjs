#!/usr/bin/env node
// Opt-in live re-capture of the session driver fixtures (never run in CI).
//
//   SPECRAILS_LIVE_PROVIDER_SMOKE=1 node scripts/capture-session-fixtures.mjs [claude|codex|all] [--out <dir>]
//
// Runs the real provider CLIs with cheap models against an empty temporary
// workspace, records every stdin/stdout line with relative timestamps, and
// writes sanitized transcripts (`{t, dir, json}` per line) that the fixture
// replayer and the driver tests consume. Costs a few cents per run.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.SPECRAILS_LIVE_PROVIDER_SMOKE !== '1') {
  console.error('Refusing to call paid providers: set SPECRAILS_LIVE_PROVIDER_SMOKE=1 to capture fixtures.')
  process.exit(2)
}

const which = process.argv[2] ?? 'all'
const outIndex = process.argv.indexOf('--out')
const outDir = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : fileURLToPath(new URL('../src/agent-runtime/session/testing/fixtures/', import.meta.url))
const claudeModel = process.env.CAPTURE_CLAUDE_MODEL ?? 'haiku'
const codexModel = process.env.CAPTURE_CODEX_MODEL ?? 'gpt-5.6-luna'
mkdirSync(outDir, { recursive: true })

function sanitize(text, workspace) {
  return text
    .split(workspace).join('<TMP>')
    .split(tmpdir()).join('<TMP>')
    .split(homedir()).join('<HOME>')
    .split(hostname()).join('<HOST>')
    .replace(/"installationId":"[^"]*"/g, '"installationId":"<ID>"')
}

function record(name, command, args, script, endAtMs) {
  return new Promise((resolve) => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'session-capture-'))
    const rows = []
    const t0 = Date.now()
    const child = spawn(command, args, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let buffer = ''
    const write = (json) => { rows.push({ t: Date.now() - t0, dir: 'in', json }); child.stdin.write(`${JSON.stringify(json)}\n`) }
    const control = (json) => rows.push({ t: Date.now() - t0, dir: 'ctl', json })
    const handlers = []
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let json = null
        try { json = JSON.parse(line) } catch { rows.push({ t: Date.now() - t0, dir: 'out', raw: line }); continue }
        rows.push({ t: Date.now() - t0, dir: 'out', json })
        for (const handler of handlers) handler(json)
      }
    })
    const finish = (why) => {
      control({ end: why })
      writeFileSync(path.join(outDir, `${name}.jsonl`), sanitize(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', workspace))
      rmSync(workspace, { recursive: true, force: true })
      console.log(`${name}: ${rows.length} rows (${why})`)
      resolve()
    }
    child.on('exit', (code, signal) => setTimeout(() => finish(`exit code=${code} sig=${signal}`), 200))
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }, endAtMs)
    script({ write, control, onFrame: (handler) => handlers.push(handler), kill: () => { control({ kill: 'SIGTERM-group' }); try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }, end: () => { control({ closeStdin: true }); child.stdin.end() } })
  })
}

const claudeArgs = (extra = []) => ['-p', '--model', claudeModel, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--setting-sources', 'project,local', '--replay-user-messages', ...extra]
const user = (uuid, content) => ({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })

async function captureClaude() {
  await record('claude-bg-complete', 'claude', claudeArgs(), ({ write }) => {
    setTimeout(() => write(user('u1', 'Use the Agent tool with run_in_background=true to launch ONE general-purpose subagent. Its task: run the bash command `sleep 30 && echo SUBDONE` and report the output. After launching it, reply only LAUNCHED and end your turn. When you are notified it finished, reply with one line summarizing its result.')), 500)
  }, 150_000)
  await record('claude-fg', 'claude', claudeArgs(), ({ write, end }) => {
    setTimeout(() => write(user('u1', 'Use the Agent tool (foreground, NOT background) to launch ONE general-purpose subagent whose task is: run `echo FGDONE` with bash and report the output. Then reply with one line.')), 500)
    setTimeout(end, 80_000)
  }, 90_000)
  await record('claude-disallowed', 'claude', claudeArgs(['--disallowedTools', 'Agent,Task']), ({ write, end }) => {
    setTimeout(() => write(user('u1', 'Use the Agent tool to launch a subagent that runs `echo X`. If the Agent tool is not available, say exactly NO_AGENT_TOOL and list the tool names you have.')), 500)
    setTimeout(end, 50_000)
  }, 60_000)
}

async function captureCodex() {
  const codex = (name, extra, prompts, endAtMs) => record(name, 'codex', [...extra, 'app-server', '--listen', 'stdio://'], ({ write, onFrame }) => {
    let id = 0; let thread = null; let next = 0
    const rpc = (method, params) => write({ id: ++id, method, params })
    const turn = () => { if (next < prompts.length) rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: prompts[next++], text_elements: [] }], model: codexModel, effort: 'low' }) }
    onFrame((frame) => {
      if (frame.id === 1 && frame.result) { write({ method: 'initialized' }); rpc('thread/start', { model: codexModel, cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'workspace-write' }) }
      else if (frame.id === 2 && frame.result) { thread = frame.result.thread.id; turn() }
      else if (frame.method === 'turn/completed' && frame.params?.threadId === thread) setTimeout(turn, 1_500)
      else if (frame.id !== undefined && frame.method) write({ id: frame.id, result: /requestApproval/.test(frame.method) ? { decision: 'decline' } : {} })
    })
    rpc('initialize', { clientInfo: { name: 'specrails_capture', title: 'Specrails capture', version: '1' }, capabilities: { experimentalApi: true } })
  }, endAtMs)
  await codex('codex-multi-wait', [], ["Use your multi-agent tools: spawn TWO sub-agents in parallel. Agent A must run the shell command 'sleep 15 && echo A_DONE'. Agent B must run 'sleep 30 && echo B_DONE'. Wait for both to finish, then reply with one line containing both outputs."], 160_000)
  await codex('codex-spawn-nowait', [], ["Call your spawn_agent tool exactly once to create a sub-agent whose task is: run the shell command 'sleep 35 && echo LATE_DONE' and report its output. You MUST NOT call wait, and you MUST NOT run any shell command yourself. Right after spawn_agent returns, reply only LAUNCHED and end your turn.", 'Now call wait on the sub-agent you spawned earlier and report its final message in one line.'], 130_000)
  await codex('codex-disabled', ['-c', 'features.multi_agent=false'], ["If you have a tool to spawn sub-agents, use it to run 'echo X'. If you do not have one, reply exactly NO_AGENT_TOOL and list your tool names."], 70_000)
}

if (which === 'claude' || which === 'all') await captureClaude()
if (which === 'codex' || which === 'all') await captureCodex()
console.log(`Fixtures written to ${outDir}. Review them, run the driver tests, and update reference/provider-findings.md if behaviour changed.`)
