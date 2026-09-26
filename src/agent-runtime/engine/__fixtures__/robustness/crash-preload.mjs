// Test-only Node --import preloader. Nothing in production reads fault controls.
// Instrument the installed execution boundary, then let Node run the real CLI.
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const cli = process.env.SPECRAILS_ENGINE_CLI
const cut = process.env.SPECRAILS_ENGINE_CRASH_AT
if (!cli || !cut) throw new Error('The robustness preloader requires a CLI and cut')
const separator = cut.lastIndexOf(':'), nodePath = cut.slice(0, separator), phase = cut.slice(separator + 1)
if (!nodePath || !['before', 'during', 'after-writes', 'after-snapshot'].includes(phase)) throw new Error('Invalid robustness cut')
const { DefinitionExecution } = await import(new URL('./engine/execution.js', pathToFileURL(cli)).href)
const prototype = DefinitionExecution.prototype
const execute = prototype.execute, committed = prototype.committed, enter = prototype.enter
const settled = new WeakSet()
function kill() {
  writeSync(2, `engine-test-crash ${cut}\n`)
  process.kill(process.pid, 'SIGKILL')
  throw new Error('SIGKILL did not terminate the fixture process')
}
prototype.execute = function(frame, effect, operation) {
  return execute.call(this, frame, effect, async signal => {
    if (frame.nodePath === nodePath && phase === 'before') kill()
    const result = await operation(signal)
    if (frame.nodePath === nodePath && phase === 'during') kill()
    return result
  })
}
prototype.committed = function(events) {
  committed.call(this, events)
  if (events.some(event => event.nodePath === nodePath && /^step_(succeeded|failed|blocked)$/.test(event.type))) {
    if (phase === 'after-writes') kill()
    settled.add(this)
  }
}
prototype.enter = function(input) {
  if (phase === 'after-snapshot' && settled.has(this)) kill()
  return enter.call(this, input)
}
