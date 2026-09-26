import type { ComponentBody, WorkflowDefinition } from './definition-types.js'

/** Public topology contains no prompts, command arguments, credentials or state. */
export function describeDefinition(runId: string, definition: WorkflowDefinition) {
  const describe = (body: Pick<ComponentBody, 'entry' | 'nodes'>) => ({ entry: body.entry,
    nodes: Object.entries(body.nodes).map(([id, node]) => ({ id, kind: node.kind, label: node.label ?? id, ends: { ...node.ends },
      ...(node.kind === 'component' ? { component: String(node.params.ref) } : node.kind === 'map' ? { component: String(node.params.body) } : {}) })) })
  const body = describe(definition)
  const edges = body.nodes.flatMap(node => Object.entries(node.ends).map(([label, to]) => ({ from: node.id, label, to })))
  const ids = new Map(body.nodes.map((node, index) => [node.id, 'n' + index]))
  const quote = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '#34;').replace(/[\r\n]/g, ' ')
  const mermaid = ['flowchart TD', ...body.nodes.map(node => `  ${ids.get(node.id)}["${quote(node.label)}"]`),
    ...edges.filter(edge => edge.to !== null).map(edge => `  ${ids.get(edge.from)} -->|"${quote(edge.label)}"| ${ids.get(edge.to!)}`)].join('\n')
  return { type: 'runtime-graph' as const, engineVersion: 2, runId, definitionHash: definition.version, workflowId: definition.id,
    nodes: body.nodes.map(node => ({ path: node.id, kind: node.kind, label: node.label })), edges, mermaid,
    graph: { id: definition.id, version: definition.version, ...body,
      ...(definition.components ? { components: Object.fromEntries(Object.entries(definition.components).map(([id, component]) => [id, describe(component)])) } : {}) } }
}
