import assert from 'node:assert/strict'
import path from 'node:path'
import { Annotation, Command, END, getWriter, interrupt, Send, START, StateGraph } from '@langchain/langgraph'
import { SpikeSqliteSaver } from './sqlite-saver.mjs'

const concat = { reducer: (a, b) => a.concat(b), default: () => [] }

export async function subgraphProbe(directory) {
  const saver = new SpikeSqliteSaver(path.join(directory, 'subgraphs', 'run.sqlite'))
  try {
    const physicalCalls = new Map()
    const countCall = key => physicalCalls.set(key, (physicalCalls.get(key) ?? 0) + 1)
    const Child = Annotation.Root({ item: Annotation(), completed: Annotation(concat), answers: Annotation(concat) })
    const childBuilder = new StateGraph(Child)
      .addNode('prepare', state => { countCall(`prepare-${state.item}`); return { completed: [`prepare-${state.item}`] } })
      .addNode('ask', state => {
        countCall(`ask-${state.item}`)
        const answer = state.item === 1 ? interrupt({ question: 'Approve branch 1?' }) : 'automatic'
        getWriter()?.({ kind: 'branch-answer', item: state.item })
        return { completed: [`answer-${state.item}`], answers: [{ item: state.item, answer }] }
      })
      .addEdge(START, 'prepare').addEdge('prepare', 'ask').addEdge('ask', END)
    const Parent = Annotation.Root({ completed: Annotation(concat), answers: Annotation(concat) })
    let joins = 0
    const parent = new StateGraph(Parent)
      .addNode('branch', childBuilder.compile())
      .addNode('join', () => { joins += 1; return { completed: ['join'] } }, { defer: true })
      .addConditionalEdges(START, () => [0, 1].map(item => new Send('branch', { item, completed: [], answers: [] })), ['branch'])
      .addEdge('branch', 'join').addEdge('join', END)
      .compile({ checkpointer: saver })
    const config = { configurable: { thread_id: 'branches' }, durability: 'sync' }
    const chunks = []
    for await (const chunk of await parent.stream({}, { ...config, streamMode: ['updates', 'custom'], subgraphs: true })) chunks.push(chunk)
    const paused = await parent.getState(config, { subgraphs: true })
    assert.equal(joins, 0, 'Deferred join must wait for the interrupted branch')
    const interrupted = paused.tasks.flatMap(task => task.interrupts ?? [])
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0].value.question, 'Approve branch 1?')
    const namespaces = saver.db.prepare("SELECT DISTINCT checkpoint_ns FROM checkpoints WHERE thread_id='branches' AND checkpoint_ns<>''").all().map(row => row.checkpoint_ns)
    assert.equal(namespaces.length, 2, 'Each Send branch needs a distinct namespace')
    const histories = []
    for (const namespace of namespaces) {
      const history = []
      for await (const entry of parent.getStateHistory({ configurable: { thread_id: 'branches', checkpoint_ns: namespace } })) history.push(entry)
      assert.ok(history.length >= 2)
      histories.push({ namespace, snapshots: history.length })
    }
    assert.ok(chunks.some(chunk => Array.isArray(chunk[0]) && chunk[0].length > 0), 'Nested stream must carry its namespace')

    // New-run fork is an explicit seed copy, not updateState on the source thread.
    const nested = paused.tasks.map(task => task.state).find(state => state?.values?.item === 1)
    assert.ok(nested?.config, 'Subgraph inspection must expose an internal checkpoint config')
    const childHistory = []
    for await (const entry of parent.getStateHistory(nested.config)) childHistory.push(entry)
    const beforeAsk = childHistory.find(entry => entry.next.includes('ask'))
    assert.ok(beforeAsk, 'History must identify a checkpoint before the internal ask node')
    const sourceBefore = JSON.stringify(saver.db.prepare("SELECT * FROM checkpoints WHERE thread_id='branches' ORDER BY checkpoint_ns,checkpoint_id").all())
    const forkChild = childBuilder.compile({ checkpointer: saver })
    const forkConfig = await forkChild.updateState({ configurable: { thread_id: 'forked-branch' } }, structuredClone(beforeAsk.values), 'prepare')
    await forkChild.invoke(null, { ...forkConfig, durability: 'sync' })
    const forked = await forkChild.invoke(new Command({ resume: 'fork-answer' }), { configurable: { thread_id: 'forked-branch' }, durability: 'sync' })
    assert.equal(forked.answers[0].answer, 'fork-answer')
    assert.equal(JSON.stringify(saver.db.prepare("SELECT * FROM checkpoints WHERE thread_id='branches' ORDER BY checkpoint_ns,checkpoint_id").all()), sourceBefore, 'Fork must preserve source history')

    const completedSiblingCalls = { prepare: physicalCalls.get('prepare-0'), ask: physicalCalls.get('ask-0') }
    assert.deepEqual(completedSiblingCalls, { prepare: 1, ask: 1 })
    const resumed = await parent.invoke(new Command({ resume: { [interrupted[0].id]: 'approved' } }), config)
    assert.deepEqual({ prepare: physicalCalls.get('prepare-0'), ask: physicalCalls.get('ask-0') }, completedSiblingCalls, 'Completed sibling nodes must not physically execute again')
    assert.equal(joins, 1)
    assert.deepEqual(resumed.answers.map(answer => answer.item).sort(), [0, 1])
    assert.equal(resumed.answers.find(answer => answer.item === 1).answer, 'approved')
    assert.equal(resumed.completed.filter(id => id === 'answer-0').length, 1, 'Completed branch must not repeat on sibling resume')

    const Jump = Annotation.Root({ completed: Annotation(concat) })
    const jumpChild = new StateGraph(Jump)
      .addNode('leave', () => new Command({ graph: Command.PARENT, goto: 'after', update: { completed: ['child-jump'] } }))
      .addEdge(START, 'leave').compile()
    const jumpParent = new StateGraph(Jump).addNode('child', jumpChild, { ends: ['after'] })
      .addNode('after', () => ({ completed: ['parent-after'] })).addEdge(START, 'child').addEdge('after', END)
      .compile({ checkpointer: saver })
    const jump = await jumpParent.invoke({}, { configurable: { thread_id: 'parent-command' }, durability: 'sync' })
    assert.deepEqual(jump.completed, ['child-jump', 'parent-after'])

    let attempts = 0
    const retried = new StateGraph(Jump).addNode('transient', () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('fixture provider failure'), { code: 'provider_request_error' })
      return { completed: ['retry-ok'] }
    }, { retryPolicy: { maxAttempts: 2, initialInterval: 1, maxInterval: 1, jitter: false, retryOn: error => error.code === 'provider_request_error' } })
      .addEdge(START, 'transient').addEdge('transient', END).compile({ checkpointer: saver })
    assert.deepEqual((await retried.invoke({}, { configurable: { thread_id: 'retry' } })).completed, ['retry-ok'])
    assert.equal(attempts, 2)

    let nestedVisits = 0
    const deepChild = new StateGraph(Jump)
    for (let index = 0; index < 4; index += 1) {
      deepChild.addNode('n' + index, () => { nestedVisits += 1; return {} })
      deepChild.addEdge(index ? 'n' + (index - 1) : START, 'n' + index)
    }
    deepChild.addEdge('n3', END)
    const outer = new StateGraph(Jump).addNode('inner', deepChild.compile())
      .addNode('after-one', () => { nestedVisits += 1; return {} })
      .addNode('after-two', () => { nestedVisits += 1; return {} })
      .addEdge(START, 'inner').addEdge('inner', 'after-one').addEdge('after-one', 'after-two').addEdge('after-two', END).compile()
    await outer.invoke({}, { recursionLimit: 5 })
    assert.equal(nestedVisits, 6)
    // Seven internal + external node visits complete at a recursion limit of 5:
    // LangGraph's superstep limit is not a universal count of definition visits.
    await assert.rejects(outer.invoke({}, { recursionLimit: 2 }), error => error.name === 'GraphRecursionError')

    return { branches: 2, branchInterruptResume: true, deferredJoinCount: joins, namespaces: histories,
      namespaceStreamChunks: chunks.filter(chunk => chunk[0]?.length).length, internalCheckpointHistory: true,
      completedSiblingPhysicalCalls: completedSiblingCalls,
      newThreadForkSeed: true, sourceUnchangedAfterFork: true, commandParent: true, classifiedRetryAttempts: attempts,
      recursionLimitNeedsGlobalVisitCounter: true, nestedNodeVisitsAtLimitFive: 7,
      forkLimitation: 'updateState seeds a fresh child thread from inspected state; copying a complete parent-plus-branch run and preserving pending interrupts remains C3/C6 work' }
  } finally { saver.close() }
}
