import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runPerfCheck } from './perf-check.js'

describe('runPerfCheck', () => {
  let prevEnv: string | undefined

  beforeEach(() => {
    prevEnv = process.env.MODIFIED_FILES_LIST
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MODIFIED_FILES_LIST
    else process.env.MODIFIED_FILES_LIST = prevEnv
  })

  it('returns NO_PERF_IMPACT status with empty modified list by default', async () => {
    delete process.env.MODIFIED_FILES_LIST
    const result = await runPerfCheck({})
    expect(result.status).toBe('NO_PERF_IMPACT')
    expect(result.modifiedFiles).toBe('')
  })

  it('reflects MODIFIED_FILES_LIST from the environment', async () => {
    process.env.MODIFIED_FILES_LIST = 'templates/agents/x.md templates/rules/y.md'
    const result = await runPerfCheck({})
    expect(result.modifiedFiles).toContain('templates/agents/x.md')
  })

  it('accepts an explicit --files flag', async () => {
    delete process.env.MODIFIED_FILES_LIST
    const result = await runPerfCheck({ files: 'src/a.ts src/b.ts' })
    expect(result.modifiedFiles).toBe('src/a.ts src/b.ts')
  })
})
