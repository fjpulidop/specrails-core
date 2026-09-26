import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runRuntimeCommand, RUNTIME_CLI_OPERATIONS } from '../cli.js'
import { CORE_WORKFLOW_VERSION } from '../core-host.js'
import * as engine from './index.js'
import { NODE_KINDS_VERSION } from './cli.js'
import { PIECE_KINDS } from './definition-types.js'
import { definitionVersion } from './canonical-json.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { validationPieceRegistry } from './pieces/index.js'
import { workflowDefinitionSchema } from './definition-schema.js'

/** Published package surface: exports, files and the catalog a host can discover. */
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const read = (relative: string) => JSON.parse(readFileSync(path.join(packageRoot, relative), 'utf8')) as Record<string, any>
const pkg = read('package.json')
const contract = read('integration-contract.json')
/** Every SDK name listed by src/agent-runtime/engine/index.ts. */
const ENGINE_SDK_EXPORTS = ['createRun', 'resumeRun', 'signalRun', 'cancelRun', 'definitionRunDirectory', 'forkRun', 'statusRun',
  'preflightDefinition', 'configuredRoles', 'validateWorkflowDefinition', 'workflowDefinitionSchema', 'definitionVersion', 'canonicalJson',
  'validationPieceRegistry', 'PieceRegistry', 'compileWorkflowDefinition', 'describeDefinition', 'PIECE_KINDS', 'EngineError'] as const

async function workflowsList() {
  const output: Record<string, any>[] = []
  expect(await runRuntimeCommand({}, ['workflows', 'list'], value => output.push(value as Record<string, any>))).toBe(0)
  expect(output).toHaveLength(1)
  return output[0]
}

describe('package exports and files', () => {
  it('exposes the engine subpath and the definition schema through package.json exports', () => {
    expect(pkg.exports['./agent-runtime/engine']).toEqual({ types: './dist/agent-runtime/engine/index.d.ts', import: './dist/agent-runtime/engine/index.js', default: './dist/agent-runtime/engine/index.js' })
    expect(pkg.exports['./schemas/workflow-definition.schema.json']).toBe('./schemas/workflow-definition.schema.json')
    expect(pkg.exports['./schemas/agent-runtime.schema.json']).toBe('./schemas/agent-runtime.schema.json')
    expect(pkg.exports['./agent-runtime']).toMatchObject({ types: './dist/agent-runtime/index.d.ts', import: './dist/agent-runtime/index.js' })
    for (const target of Object.values(pkg.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value as Record<string, string>))) {
      expect(existsSync(path.join(packageRoot, target)), `${target} must exist after npm run build`).toBe(true)
    }
    expect(pkg.bin).toEqual({ 'specrails-core': 'bin/specrails-core.mjs' })
    expect(pkg.engines.node).toBe('>=22.22.3')
    expect(contract.agentRuntime.minimumNode).toBe('22.22.3')
  })

  it('ships schemas, templates, pinned versions and both entries through the files allowlist', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['bin/', 'dist/', 'templates/', 'schemas/', 'integration-contract.json', 'pinned-versions.json']))
    expect(pkg.files.some((entry: string) => /^src\b|test/.test(entry))).toBe(false)
    const pinned = read('pinned-versions.json')
    expect(pinned.openspec).toBe(pkg.dependencies['@fission-ai/openspec'])
    expect(readdirSync(path.join(packageRoot, 'templates')).sort()).toEqual(['agents', 'codex-skills', 'commands', 'kimi', 'settings'])
    expect(readdirSync(path.join(packageRoot, 'templates', 'agents')).sort()).toEqual(['sr-architect.md', 'sr-developer.md', 'sr-reviewer.md'])
    for (const relative of ['templates/commands/specrails', 'templates/codex-skills/rails', 'templates/kimi/specrails', 'templates/settings/codex-config.toml', 'templates/settings/gemini-settings.json']) {
      expect(existsSync(path.join(packageRoot, relative)), relative).toBe(true)
    }
    const schema = read('schemas/workflow-definition.schema.json')
    expect(schema.$id).toBe('https://specrails.dev/schemas/workflow-definition/1')
    expect(schema.required).toContain('version')
    expect(schema).toEqual(workflowDefinitionSchema)
    expect(contract.agentRuntime.configSchemaExport).toBe('specrails-core/schemas/agent-runtime.schema.json')
  })

  it('exports every documented engine SDK name from the engine subpath', () => {
    for (const name of ENGINE_SDK_EXPORTS) expect(engine[name], name).toBeDefined()
    expect(Object.keys(engine).filter(name => !ENGINE_SDK_EXPORTS.includes(name as typeof ENGINE_SDK_EXPORTS[number]))).toEqual([])
    expect(engine.PIECE_KINDS).toHaveLength(16)
    expect(new engine.EngineError('run_not_found', 'missing').code).toBe('run_not_found')
    expect(engine.workflowDefinitionSchema).toBe(workflowDefinitionSchema)
  })
})

describe('runtime workflows catalog', () => {
  it('lists exactly the sixteen production node kinds with no test-only piece', async () => {
    const listed = await workflowsList()
    expect(listed).toMatchObject({ type: 'runtime-workflows', nodeKindsVersion: NODE_KINDS_VERSION, builtins: [{ id: 'specrails-implementation', version: CORE_WORKFLOW_VERSION, deprecated: false }] })
    expect(listed.definitionSchema).toEqual(workflowDefinitionSchema)
    const kinds = (listed.nodeKinds as Array<Record<string, unknown>>).map(descriptor => descriptor.kind)
    expect(kinds).toHaveLength(16)
    expect([...kinds].sort()).toEqual([...PIECE_KINDS].sort())
    expect(kinds.filter(kind => /fixture|test|spike|mock|fake/i.test(String(kind)))).toEqual([])
    for (const descriptor of listed.nodeKinds as Array<Record<string, unknown>>) {
      expect(typeof descriptor.requiresAI).toBe('boolean')
      expect(['read', 'write', 'derived']).toContain(descriptor.effect)
      expect(Array.isArray(descriptor.outcomes)).toBe(true)
      expect(descriptor.paramsSchema).toMatchObject({ type: 'object' })
      expect(JSON.stringify(descriptor)).not.toMatch(/fixture|__spikes__|vitest/i)
    }
    expect(new Set(validationPieceRegistry().catalog().map(descriptor => descriptor.kind))).toEqual(new Set(PIECE_KINDS))
  })

  it('mirrors machine operations in the integration contract', () => {
    expect(contract.agentRuntime.cliOperations).toEqual(RUNTIME_CLI_OPERATIONS.filter(operation => operation !== 'help'))
    expect(contract.agentRuntime.cliPresentationOperations).toEqual(['help'])
    expect(contract.agentRuntime.cliOperations).toEqual(expect.arrayContaining(['workflows', 'fork', 'signal', 'cancel']))
  })

  it('publishes the acceptance fixture from the production catalog with a reproducible hash', () => {
    const fixture = read('src/agent-runtime/engine/__fixtures__/acceptance/question-flow.json')
    const { version, ...draft } = fixture
    expect(definitionVersion(draft)).toBe(version)
    const result = validateWorkflowDefinition(fixture, validationPieceRegistry(), {}, { published: true })
    expect(result).toMatchObject({ ok: true, version })
    expect(Object.values(fixture.nodes as Record<string, { kind: string }>).every(node => ['condition', 'question', 'end'].includes(node.kind))).toBe(true)
    const config = read('src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json')
    expect(config.providers.map((provider: { id: string }) => provider.id)).toEqual(['claude'])
  })
})
