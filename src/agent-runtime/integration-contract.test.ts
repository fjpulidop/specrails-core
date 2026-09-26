import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RUNTIME_CLI_OPERATIONS, runRuntimeCommand } from './cli.js'
import { CORE_WORKFLOW_VERSION, RUNTIME_API_VERSION, coreRuntimeIdentity } from './core-host.js'
import { NODE_KINDS_VERSION } from './engine/piece-registry.js'
import { validationPieceRegistry } from './engine/pieces/index.js'
import { CORE_NODE_ORDER } from './graph/state.js'
import { ROLE_INSTRUCTIONS_VERSION } from './prompts.js'

const ENGINE_V2_CAPABILITIES = ['engineV2', 'workflowDefinitions', 'openRoles', 'fanOut', 'fork', 'steeringInbox'] as const

const contract = JSON.parse(readFileSync(new URL('../../integration-contract.json', import.meta.url), 'utf8'))

describe('Desktop integration contract', () => {
  it('matches the runtime identity and ordered implementation phases', () => {
    expect(contract.schemaVersion).toBe('5.1')
    expect(contract.agentRuntime.apiVersion).toBe(RUNTIME_API_VERSION)
    expect(contract.agentRuntime.workflowVersion).toBe(CORE_WORKFLOW_VERSION)
    expect(contract.agentRuntime.instructionsVersion).toBe(String(ROLE_INSTRUCTIONS_VERSION))
    expect(contract.agentRuntime.phases).toEqual(CORE_NODE_ORDER)
    expect(coreRuntimeIdentity()).toMatchObject({
      apiVersion: contract.agentRuntime.apiVersion,
      workflowVersion: contract.agentRuntime.workflowVersion,
      instructionsVersion: contract.agentRuntime.instructionsVersion,
    })
  })

  it('covers every machine operation exactly once and classifies presentation separately', () => {
    expect(contract.agentRuntime.cliPresentationOperations).toEqual(['help'])
    expect(contract.agentRuntime.cliOperations).toEqual(RUNTIME_CLI_OPERATIONS.filter(operation => operation !== 'help'))
    expect(new Set(RUNTIME_CLI_OPERATIONS).size).toBe(RUNTIME_CLI_OPERATIONS.length)
  })

  it('advertises the real engine v2 catalog: contract, runtime api and workflows list agree with the validation registry', async () => {
    const registry = validationPieceRegistry(), kinds = registry.kinds()
    expect(kinds).toHaveLength(16)
    expect(kinds).toEqual(registry.catalog().map(piece => piece.kind))
    expect(kinds.some(kind => /test|fixture|fake/.test(kind))).toBe(false)
    expect(contract.agentRuntime.engine).toEqual({ version: 2, definitionSchema: 'schemas/workflow-definition.schema.json', nodeKindsVersion: NODE_KINDS_VERSION })
    expect(existsSync(new URL('../../' + contract.agentRuntime.engine.definitionSchema, import.meta.url))).toBe(true)
    expect(contract.agentRuntime.nodeKinds).toEqual(kinds)
    expect(contract.agentRuntime.builtins).toEqual([{ id: 'specrails-implementation', version: CORE_WORKFLOW_VERSION, deprecated: false }])

    const messages: unknown[] = []
    expect(await runRuntimeCommand({}, ['api'], value => messages.push(value))).toBe(0)
    expect(messages).toHaveLength(1)
    const api = messages[0] as { apiVersion: number; workflowVersions: string[]; engineVersion: number; nodeKindsVersion: number; nodeKinds: string[]; capabilities: Record<string, unknown> }
    expect(api).toMatchObject({ apiVersion: RUNTIME_API_VERSION, workflowVersions: [CORE_WORKFLOW_VERSION], engineVersion: contract.agentRuntime.engine.version, nodeKindsVersion: NODE_KINDS_VERSION })
    expect(api.nodeKinds).toEqual(contract.agentRuntime.nodeKinds)
    for (const name of ENGINE_V2_CAPABILITIES) expect(api.capabilities[name]).toBe(1)
    // Desktop's loader accepts only safe integers >= 1 for every capability value.
    expect(Object.values(api.capabilities).every(value => Number.isSafeInteger(value) && (value as number) >= 1)).toBe(true)

    const workflows: unknown[] = []
    expect(await runRuntimeCommand({}, ['workflows', 'list'], value => workflows.push(value))).toBe(0)
    const listed = workflows[0] as { nodeKindsVersion: number; nodeKinds: { kind: string }[]; builtins: unknown }
    expect(listed.nodeKindsVersion).toBe(NODE_KINDS_VERSION)
    expect(listed.nodeKinds.map(piece => piece.kind)).toEqual(contract.agentRuntime.nodeKinds)
    expect(listed.builtins).toEqual(contract.agentRuntime.builtins)
  })

  it('rejects operations outside the catalog before reading a context', async () => {
    await expect(runRuntimeCommand({}, ['unsupported-operation'])).rejects.toThrow('Unknown runtime operation: unsupported-operation')
  })
})
