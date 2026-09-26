// Test-only fault injection at the actual filesystem publication boundaries.
import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const rename = fs.renameSync
const phase = process.env.SPECRAILS_FORK_CRASH
function kill() { fs.writeSync(2, `fork-crash:${phase}\n`); process.kill(process.pid, 'SIGKILL'); throw Error('SIGKILL failed') }
fs.renameSync = function(source, target) {
  const publish = path.basename(target) === 'run.sqlite'
  if (phase === 'before-publish' && publish) kill()
  const result = rename(source, target)
  if (phase === 'after-allocation' && path.basename(target) === 'crash-child') kill()
  if (phase === 'after-change' && path.basename(path.dirname(target)) === 'changes') kill()
  if (phase === 'after-publish' && publish) kill()
  return result
}
syncBuiltinESMExports()
