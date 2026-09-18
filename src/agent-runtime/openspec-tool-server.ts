import { readVerificationEvidence } from '../installer/runtime/pipeline-state.js'
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { IMPLEMENTATION_PROGRESS_SCHEMA, OPENSPEC_TOOL_ACTIONS, OPENSPEC_TOOL_DEFINITION, OpenSpecTools, type OpenSpecRoleContext } from './openspec.js'

const configPath = process.argv[2]
if (!configPath) throw new Error('Missing role OpenSpec context')
const context = JSON.parse(readFileSync(configPath, 'utf8')) as OpenSpecRoleContext
const server = new McpServer({ name: 'specrails-openspec', version: '1' })
server.registerTool('workflow', {
  description: OPENSPEC_TOOL_DEFINITION.function.description,
  inputSchema: { action: z.enum(OPENSPEC_TOOL_ACTIONS), artifact: z.string().optional(), path: z.string().optional(), content: z.string().optional(), progress: IMPLEMENTATION_PROGRESS_SCHEMA.optional() },
}, async (args, extra) => {
  const tools = new OpenSpecTools(context, extra.signal)
  try { return { content: [{ type: 'text', text: JSON.stringify(await tools.execute(args)) }] } }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } }
})
if (context.evidenceScope && context.role !== 'architect') server.registerTool('read_verification_evidence', {
  description: 'Read persisted host verification results and harness sources. List first to discover opaque IDs; use returned cursors to page output. Read-only, bounded and scoped to this run.',
  inputSchema: { id: z.string().optional(), section: z.enum(['summary', 'stdout', 'stderr', 'source']).optional(), sourceId: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
}, async args => {
  try { return { content: [{ type: 'text', text: JSON.stringify(readVerificationEvidence(context.evidenceScope!, args)) }] } }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } }
})
await server.connect(new StdioServerTransport())
