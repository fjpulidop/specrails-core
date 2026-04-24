import { info, rawOut } from '../util/logger.js'

/**
 * `npx specrails-core perf-check` — performance regression sentinel.
 *
 * specrails-core is a template/installer package with no runtime hot
 * paths; the command is kept for CI compatibility and emits the same
 * `PERF_STATUS: NO_PERF_IMPACT` line downstream CI jobs grep for.
 */

export interface PerfCheckFlags {
  files?: string | boolean
  context?: string | boolean
}

export interface PerfCheckResult {
  status: 'NO_PERF_IMPACT'
  modifiedFiles: string
}

export async function runPerfCheck(flags: PerfCheckFlags = {}): Promise<PerfCheckResult> {
  const modifiedFiles = resolveModifiedFiles(flags)

  rawOut('specrails-core performance check\n')
  rawOut(`Modified files: ${modifiedFiles.length > 0 ? modifiedFiles : '<none>'}\n\n`)

  info(
    'This repository contains an installer + Markdown templates — no runtime benchmarks apply.',
  )

  rawOut('\nPERF_STATUS: NO_PERF_IMPACT\n')
  return { status: 'NO_PERF_IMPACT', modifiedFiles }
}

function resolveModifiedFiles(flags: PerfCheckFlags): string {
  if (typeof flags.files === 'string') return flags.files
  const envList = process.env.MODIFIED_FILES_LIST
  return envList && envList.length > 0 ? envList : ''
}
