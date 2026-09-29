// Test-only Node --import preloader. Nothing in production reads these controls.
// Replaces the `fixture` provider of the Quick SDD reference definition with a
// deterministic local executor so the real CLI can be killed at every node.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cli = process.env.SPECRAILS_ENGINE_CLI
const calls = process.env.SPECRAILS_QUICK_SDD_CALLS, change = process.env.SPECRAILS_QUICK_SDD_CHANGE
if (!cli || !calls || !change) throw new Error('The Quick SDD executor requires a CLI, a call log and a change')
const runtime = new URL('./', pathToFileURL(cli))
const { ExecutorRegistry } = await import(new URL('executors.js', runtime).href)
const { resolveOpenSpecCli, runOpenSpec } = await import(new URL('openspec.js', runtime).href)
const files = {
  'proposal.md': '## Why\nReturn the required value.\n## What Changes\nUpdate value.cjs.\n## Capabilities\n### New Capabilities\n- value: Return two.\n## Impact\nOne function.\n',
  'design.md': '## Design\nSet the value and verify it with Node.\n',
  'specs/value/spec.md': '## ADDED Requirements\n### Requirement: Return two\nThe function SHALL return two.\n#### Scenario: Load the function\n- **WHEN** value.cjs is loaded\n- **THEN** its value is two\n',
  'tasks.md': '- [ ] 1. Update and verify the function\n',
}
const executor = {
  capabilities: () => ({ transport: 'fixture', continuation: 'unsupported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
  async execute(request) {
    const command = request.nativeCommand?.id
    if (!JSON.stringify(request.nativeCommand?.args ?? '').includes(change)) throw new Error('The native command lost its frozen change')
    fs.appendFileSync(calls, JSON.stringify({ command }) + '\n')
    const active = path.join(request.cwd, 'openspec/changes', change)
    if (command === 'opsx:ff') {
      // Idempotent so an explicitly recovered uncertain attempt can repeat safely.
      if (!fs.existsSync(active)) await runOpenSpec(resolveOpenSpecCli(), request.cwd, ['new', 'change', change, '--json'])
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(active, file)), { recursive: true })
        fs.writeFileSync(path.join(active, file), content)
      }
    } else if (command === 'opsx:apply') {
      fs.writeFileSync(path.join(request.cwd, 'value.cjs'), 'module.exports = 2\n')
      fs.writeFileSync(path.join(active, 'tasks.md'), '- [x] 1. Update and verify the function\n')
    } else throw new Error(`Unexpected Quick SDD command ${command}`)
    return { text: 'Completed native skill', usage: { inputTokens: 10, outputTokens: 5, costUsd: null } }
  },
}
const get = ExecutorRegistry.prototype.get, ids = ExecutorRegistry.prototype.ids
ExecutorRegistry.prototype.get = function(id) { return id === 'fixture' ? executor : get.call(this, id) }
ExecutorRegistry.prototype.ids = function() { return [...new Set([...ids.call(this), 'fixture'])] }
