#!/usr/bin/env node
// Thin npm bin entry: every command lives in dist/installer/cli.js.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'installer', 'cli.js')
if (!existsSync(cli)) {
  console.error(`Installer runtime not found at ${cli}. From a source checkout, run: npm run build`)
  process.exit(1)
}

const { main } = await import(pathToFileURL(cli).href)
const code = await main(process.argv.slice(2))
// Let pipe writes drain before exiting; runtime status can exceed a pipe buffer.
await Promise.all([process.stdout, process.stderr].map((stream) =>
  new Promise((resolve, reject) => stream.write('', (error) => (error ? reject(error) : resolve()))),
))
process.exit(code)
