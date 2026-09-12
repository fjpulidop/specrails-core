import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { OpenSpecTools, type OpenSpecRoleContext } from './openspec.js'

const configPath = process.argv[2]
if (!configPath) throw new Error('Missing role OpenSpec context')
const context = JSON.parse(readFileSync(configPath, 'utf8')) as OpenSpecRoleContext
const server = new McpServer({ name: 'specrails-openspec', version: '1' })
server.registerTool('workflow', {
  description: 'Execute the official OpenSpec skill and CLI operations for the current change. Load the role skill first; for developer/reviewer this also executes and returns real status and instructions apply. Read the returned context files and finish the skill. Use instructions before authoring artifacts. Change identity and write scope are fixed by the host.',
  inputSchema: { action: z.enum(['load_skill', 'new', 'status', 'instructions', 'validate', 'write_artifact']), artifact: z.string().optional(), path: z.string().optional(), content: z.string().optional() },
}, async (args, extra) => {
  const tools = new OpenSpecTools(context, extra.signal)
  try { return { content: [{ type: 'text', text: JSON.stringify(await tools.execute(args)) }] } }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } }
})
await server.connect(new StdioServerTransport())
