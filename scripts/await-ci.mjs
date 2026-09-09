import { appendFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { isMain } from './release-utils.mjs'

export function selectCiRun(runs, sha) {
  return runs.filter((run) => run.head_sha === sha && run.event === 'push' && run.head_branch === 'main')
    .sort((a, b) => b.id - a.id || (b.run_attempt ?? 1) - (a.run_attempt ?? 1))[0]
}
export async function isCurrentMain({ repository, sha, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '') || !token) throw new Error('Missing repository, SHA or read-only GitHub token')
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/git/ref/heads/main`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Unable to inspect main: HTTP ${response.status}`)
  const ref = await response.json()
  if (!/^[a-f0-9]{40}$/.test(ref.object?.sha ?? '')) throw new Error('GitHub returned no valid main SHA')
  return ref.object.sha === sha
}
export async function awaitCi({ repository, sha, token, fetchImpl = fetch, sleep = delay, maxAttempts = 180 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '') || !token) throw new Error('Missing repository, SHA or read-only GitHub token')
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Unable to inspect CI: HTTP ${response.status}`)
    const run = selectCiRun((await response.json()).workflow_runs ?? [], sha)
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`CI for ${sha} is ${run.conclusion}; rerun the failed CI before releasing`)
      return String(run.id)
    }
    if (attempt + 1 < maxAttempts) await sleep(10_000)
  }
  throw new Error('Timed out waiting for CI at the exact release commit')
}
if (isMain(import.meta.url)) {
  try {
    const input = { repository: process.env.GITHUB_REPOSITORY, sha: process.argv.includes('--current-main') ? process.env.GITHUB_SHA : (process.env.RELEASE_CI_SHA || process.env.GITHUB_SHA), token: process.env.GH_TOKEN }
    if (process.argv.includes('--current-main')) {
      const current = await isCurrentMain(input)
      appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`)
      if (!current) console.log('::notice::A newer main commit will handle Release Please; skipping obsolete metadata changes')
    } else {
      const runId = await awaitCi(input)
      appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${runId}\n`)
      console.log(`CI passed for ${input.sha} (run ${runId})`)
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
