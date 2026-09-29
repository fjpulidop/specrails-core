import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Acceptance requires every case in both modes, not just a successful subset. */
export function assertCorpusAccepted(report, cases) {
  assert.equal(report.mode, 'offline')
  assert.equal(report.stopReason, null)
  assert.equal(report.allCasesAccepted, true)
  assert.equal(report.reportedSpendUsd, 0)
  assert.equal(report.monetaryConclusion, 'inconclusive')
  assert.equal(report.observations.length, cases.length * 2)
  for (const id of cases) for (const mode of ['full', 'optimized']) {
    const rows = report.observations.filter(row => row.caseId === id && row.mode === mode)
    assert.equal(rows.length, 1, `${id}/${mode}: missing or duplicate observation`)
    assert.equal(rows[0].status, 'succeeded', `${id}/${mode}: runtime failed`)
    assert.equal(rows[0].independentAccepted, true, `${id}/${mode}: independent oracle failed`)
  }
}

async function main() {
  const { runEvaluation } = await import('../dist/agent-runtime/evaluation.js')
  const { DEFINITION_EVALUATION_CORPUS, EVALUATION_CORPUS } = await import('../dist/agent-runtime/evaluation-corpus.js')
  const [id, destination] = process.argv.slice(2)
  const definition = DEFINITION_EVALUATION_CORPUS.find(item => item.id === id)
  assert(definition && destination, 'Usage: node scripts/evaluate-definition-corpus.mjs <definition-id> <output-directory>')
  const report = await runEvaluation({ definition, output: path.resolve(destination) })
  assertCorpusAccepted(report, EVALUATION_CORPUS.map(item => item.id))
  console.log(`${id}: ${report.observations.length} independent offline acceptances; monetary savings unproven`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
