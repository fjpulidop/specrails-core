// Provider-free shell body for the C3 robustness harness. Every execution appends
// one byte to <markers>/<name>, so the byte count is the number of physical runs.
// The PID file lets the harness prove no shell child outlives the engine process.
import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [name, markers, ...rest] = process.argv.slice(2)
if (!name || !markers) { process.stderr.write('usage: marker.mjs <name> <markersDir> [--sleep ms] [--bytes n]\n'); process.exit(64) }
const option = (flag) => { const index = rest.indexOf(flag); return index >= 0 ? Number(rest[index + 1]) : 0 }
appendFileSync(path.join(markers, name), 'x')
writeFileSync(path.join(markers, name + '.pid'), String(process.pid))
const bytes = option('--bytes')
if (bytes > 0) {
  // Mixed shape: many short lines (one transient event each) plus one line that
  // exceeds every per-line bound, so both protocol paths are exercised.
  const line = `${name} `.padEnd(119, 'y') + '\n'
  let written = 0
  while (written + line.length <= bytes / 2) { process.stdout.write(line); written += line.length }
  process.stdout.write('z'.repeat(bytes - written) + '\n')
}
const sleep = option('--sleep')
if (sleep > 0) setTimeout(() => process.stdout.write(`${name} woke\n`), sleep)
else process.stdout.write(`${name} done\n`)
