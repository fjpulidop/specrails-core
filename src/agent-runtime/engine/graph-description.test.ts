import { expect, it } from 'vitest'
import { describeDefinition } from './graph-description.js'
import type { WorkflowDefinition } from './definition-types.js'

it('exports reconnectable component topology without parameter or secret values', () => {
  const definition: WorkflowDefinition = { schemaVersion: 1, id: 'public', version: 'digest', title: 'Example', journal: 'ledger-only', change: 'none', maxTransitions: 10, roles: [], entry: 'ask',
    nodes: { ask: { kind: 'component', params: { ref: 'child', inputs: { secret: 'private-value' } }, label: 'Say "yes" <safe>', ends: { next: 'done' } }, done: { kind: 'end', params: { outcome: 'success' }, ends: {} } },
    components: { child: { entry: 'finish', nodes: { finish: { kind: 'end', params: { outcome: 'success' }, ends: {} } } } } }
  const graph = describeDefinition('run', definition)
  expect(graph.graph.nodes[0]).toMatchObject({ id: 'ask', component: 'child', ends: { next: 'done' } })
  expect(graph.graph.components?.child).toMatchObject({ entry: 'finish', nodes: [{ id: 'finish', kind: 'end' }] })
  expect(graph.edges).toEqual([{ from: 'ask', label: 'next', to: 'done' }])
  expect(graph.mermaid).toContain('Say #34;yes#34; &lt;safe&gt;')
  expect(JSON.stringify(graph)).not.toContain('private-value')
  expect(JSON.stringify(graph)).not.toContain('params')
})
