import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pipelineStateDirectory, type PipelineContext, type VerificationReceipt } from '../../pipeline/pipeline-state.js'
import { SPEC_TRACE_FILE, SPEC_TRACE_SCHEMA_VERSION, traceSpecs, traceSummary, type SpecTraceReport } from '../../pipeline/spec-trace.js'
import { commandReachesTest } from '../compact/test-reachability.js'
import { write } from './artifacts.js'

/** What the verification record, the reviewer and the acceptance findings carry; the full report stays in spec-trace.json. */
export interface SpecTraceSummary {
  schemaVersion: typeof SPEC_TRACE_SCHEMA_VERSION
  receiptId: string | null
  summary: string
  requirements: number
  demonstrated: number
  touched: string[]
  touchedUndemonstrated: Array<{ id: string; reason: string }>
  untagged: Array<{ tag: string; file: string; line: number }>
  /** Absolute path of the full report. */
  path: string
}
const LIST_LIMIT = 50

export function specTracePath(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>): string {
  return path.join(pipelineStateDirectory(context as PipelineContext), SPEC_TRACE_FILE)
}

/**
 * Scans the specs and tests after a passing verification, binds the report to
 * the receipt and writes `spec-trace.json`. Advisory and fail-open: any error
 * yields `undefined` and never changes the verification outcome.
 */
export function recordSpecTrace(context: PipelineContext, change: string, receipt: Pick<VerificationReceipt, 'id' | 'commands'>, reportedTests: readonly string[] = []): SpecTraceSummary | undefined {
  try {
    const single = context.repositories.length === 1 ? context.repositories[0] : undefined
    const testFiles = single ? reportedTests.map(file => path.isAbsolute(file) ? path.relative(single.path, file) : file).filter(file => file && !file.startsWith('..')).map(file => ({ repositoryId: single.id, file })) : []
    const report = traceSpecs({
      specsRoot: context.artifactRoot, changes: [change],
      repositories: context.repositories.map(repository => ({ id: repository.id, root: repository.path })),
      testFiles, receipt: { id: receipt.id, commands: receipt.commands.map(command => {
        // Receipts record the absolute working directory; reachability wants it relative to the repository.
        const root = context.repositories.find(item => item.id === command.repositoryId)?.path
        const cwd = root && command.cwd ? path.relative(root, path.resolve(root, command.cwd)) : ''
        return { repositoryId: command.repositoryId, command: command.command, args: command.args, ...(cwd && !cwd.startsWith('..') ? { cwd } : {}), exitCode: command.exitCode }
      }) },
      reaches: commandReachesTest,
    })
    const file = specTracePath(context)
    write(file, JSON.stringify(report, null, 2) + '\n')
    return summarize(report, file, context.repositories.length > 1)
  } catch { return undefined }
}
function summarize(report: SpecTraceReport, file: string, multiple: boolean): SpecTraceSummary {
  const reasons = new Map(report.undemonstrated.map(item => [item.id, item.reason]))
  return {
    schemaVersion: report.schemaVersion, receiptId: report.receiptId, summary: traceSummary(report), requirements: report.requirements, demonstrated: report.demonstrated.length,
    touched: report.touched.slice(0, LIST_LIMIT), touchedUndemonstrated: report.touchedUndemonstrated.slice(0, LIST_LIMIT).map(id => ({ id, reason: reasons.get(id) ?? 'no-test' })),
    untagged: report.untagged.slice(0, LIST_LIMIT).map(tag => ({ tag: tag.tag, file: (multiple ? tag.repositoryId + ':' : '') + tag.file, line: tag.line })),
    path: file,
  }
}
/** The latest report of a run, or null when verification has not passed yet (or the file is unreadable). */
export function readSpecTraceReport(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>): SpecTraceReport | null {
  try {
    const file = specTracePath(context)
    if (!existsSync(file)) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as SpecTraceReport
    return value && typeof value === 'object' && value.schemaVersion === SPEC_TRACE_SCHEMA_VERSION ? value : null
  } catch { return null }
}
/** The acceptance finding that records the advisory trace next to the receipt. */
export function specTraceFinding(trace: SpecTraceSummary): string {
  const touched = trace.touched.length ? `; touched by this change ${trace.touched.length - trace.touchedUndemonstrated.length}/${trace.touched.length}${trace.touchedUndemonstrated.length ? ' (not demonstrated: ' + trace.touchedUndemonstrated.map(item => item.id).join(', ') + ')' : ''}` : ''
  return `Spec trace (advisory, receipt ${trace.receiptId ?? 'unknown'}): ${trace.summary}${touched}.`
}
