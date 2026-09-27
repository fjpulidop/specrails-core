import test from 'node:test'
import assert from 'node:assert/strict'
import { assertCorpusAccepted } from './evaluate-definition-corpus.mjs'

test('offline corpus gate rejects partial, duplicated, failed and monetarily misleading evidence', () => {
  const report = { mode: 'offline', stopReason: null, allCasesAccepted: true, reportedSpendUsd: 0, monetaryConclusion: 'inconclusive',
    observations: ['full', 'optimized'].map(mode => ({ caseId: 'case', mode, status: 'succeeded', independentAccepted: true })) }
  assert.doesNotThrow(() => assertCorpusAccepted(report, ['case']))
  for (const altered of [
    { ...report, observations: report.observations.slice(1) },
    { ...report, observations: [report.observations[0], report.observations[0]] },
    { ...report, observations: report.observations.map(row => ({ ...row, independentAccepted: false })) },
    { ...report, observations: report.observations.map(row => ({ ...row, status: 'failed' })) },
    { ...report, monetaryConclusion: 'target-met-in-this-sample' },
    { ...report, stopReason: 'interrupted' },
  ]) assert.throws(() => assertCorpusAccepted(altered, ['case']))
})
