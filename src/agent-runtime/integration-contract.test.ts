import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RUNTIME_CLI_OPERATIONS, runRuntimeCommand } from './cli.js'
import { CORE_WORKFLOW_VERSION, RUNTIME_API_VERSION, coreRuntimeIdentity } from './core-host.js'
import { CORE_NODE_ORDER } from './graph/state.js'
import { ROLE_INSTRUCTIONS_VERSION } from './prompts.js'

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

  it('advertises only the available legacy engine and built-in', async () => {
    expect(contract.agentRuntime.engine).toEqual({ version: 1, definitionSchema: null, nodeKindsVersion: 0 })
    expect(contract.agentRuntime.nodeKinds).toEqual([])
    expect(contract.agentRuntime.builtins).toEqual([{ id: 'specrails-implementation', version: CORE_WORKFLOW_VERSION, deprecated: false }])
    const messages: unknown[] = []
    expect(await runRuntimeCommand({}, ['api'], value => messages.push(value))).toBe(0)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ apiVersion: RUNTIME_API_VERSION, workflowVersions: [CORE_WORKFLOW_VERSION] })
    const capabilities = (messages[0] as { capabilities: Record<string, unknown> }).capabilities
    for (const name of ['engineV2', 'workflowDefinitions', 'fanOut', 'steeringInbox']) expect(capabilities).not.toHaveProperty(name)
  })

  it('rejects operations outside the catalog before reading a context', async () => {
    await expect(runRuntimeCommand({}, ['unsupported-operation'])).rejects.toThrow('Unknown runtime operation: unsupported-operation')
  })
})
