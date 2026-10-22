// Promote an already-published specrails-core version to the npm `stable`
// dist-tag (see docs/release-policy.md). Manual only: run from the
// `Promote stable` workflow. Importing this module never touches npm.
//
// Guards, all fail-closed:
// - the version is a published stable X.Y.Z, not deprecated, not newer than
//   `latest`, and newer than the current `stable` (stable never moves back);
// - it was published at least MIN_AGE_DAYS ago and no newer patch of the same
//   minor was published within those days (a quick follow-up patch signals an
//   incident); newer minors do not disqualify it;
// - the CI push run for its `vX.Y.Z` tag commit completed successfully.
import { compareStableVersions } from './publish-package.mjs'
import { selectCiRun } from './await-ci.mjs'
import { isMain, npm, releaseVersion } from './release-utils.mjs'

export const MIN_AGE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Pure decision from the registry document. Returns { ok, noop, errors, ageDays }. */
export function evaluatePromotion({ version, packument, now = Date.now(), minDays = MIN_AGE_DAYS }) {
  const errors = []
  if (!STABLE.test(version ?? '')) return { ok: false, noop: false, errors: ['Version must be a stable X.Y.Z'], ageDays: 0 }
  const time = packument?.time ?? {}
  const tags = packument?.['dist-tags'] ?? {}
  const published = Date.parse(time[version])
  if (!packument?.versions?.[version] || Number.isNaN(published)) return { ok: false, noop: false, errors: [`specrails-core@${version} is not published`], ageDays: 0 }
  if (tags.stable === version) return { ok: true, noop: true, errors, ageDays: 0 }
  if (packument.versions[version].deprecated) errors.push(`specrails-core@${version} is deprecated`)
  if (!tags.latest || compareStableVersions(version, tags.latest) > 0) errors.push(`specrails-core@${version} is newer than latest (${tags.latest ?? 'none'})`)
  if (tags.stable && STABLE.test(tags.stable) && compareStableVersions(version, tags.stable) < 0) errors.push(`Refusing to move stable backwards (${tags.stable} -> ${version})`)
  const ageDays = Math.max(0, now - published) / DAY_MS
  if (ageDays < minDays) errors.push(`specrails-core@${version} was published ${ageDays.toFixed(1)} days ago; stable requires at least ${minDays}`)
  const [major, minor, patch] = version.split('.').map(Number)
  const windowEnd = published + minDays * DAY_MS
  for (const other of Object.keys(packument.versions)) {
    const match = STABLE.exec(other)
    const at = Date.parse(time[other])
    if (!match || Number(match[1]) !== major || Number(match[2]) !== minor || Number(match[3]) <= patch || Number.isNaN(at)) continue
    if (at <= windowEnd) errors.push(`specrails-core@${other} followed ${version} after ${(Math.max(0, at - published) / DAY_MS).toFixed(1)} days; a quick follow-up patch signals an incident`)
  }
  return { ok: errors.length === 0, noop: false, errors, ageDays }
}

const githubHeaders = (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' })

/** Resolves the vX.Y.Z tag commit and requires its CI push run to have succeeded. */
export async function assertTagCiGreen({ version, repository, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token) throw new Error('Missing repository or read-only GitHub token')
  const tag = 'v' + version
  releaseVersion(tag)
  const commit = await fetchImpl(`https://api.github.com/repos/${repository}/commits/${tag}`, { headers: githubHeaders(token), signal: AbortSignal.timeout(30_000) })
  if (!commit.ok) throw new Error(`Cannot resolve tag ${tag}: HTTP ${commit.status}`)
  const sha = (await commit.json()).sha
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error(`GitHub returned no valid commit for ${tag}`)
  const runs = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`, { headers: githubHeaders(token), signal: AbortSignal.timeout(30_000) })
  if (!runs.ok) throw new Error(`Unable to inspect CI: HTTP ${runs.status}`)
  const run = selectCiRun((await runs.json()).workflow_runs ?? [], sha)
  if (!run) throw new Error(`No CI push run on main found for ${tag} (${sha})`)
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error(`CI for ${tag} (${sha}) is ${run.status}/${run.conclusion ?? 'pending'}; stable requires a green tag`)
  return { sha, runId: String(run.id) }
}

export async function fetchPackument(fetchImpl = fetch) {
  const response = await fetchImpl('https://registry.npmjs.org/specrails-core', { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Cannot read the npm registry: HTTP ${response.status}`)
  const packument = await response.json()
  if (packument.name !== 'specrails-core') throw new Error('Unexpected npm registry document')
  return packument
}

if (isMain(import.meta.url)) {
  try {
    const version = process.env.PROMOTE_VERSION ?? process.argv[2]
    const dryRun = process.argv.includes('--dry-run') || process.env.PROMOTE_DRY_RUN === 'true'
    const verdict = evaluatePromotion({ version, packument: await fetchPackument() })
    if (!verdict.ok) throw new Error(verdict.errors.join('\n'))
    if (verdict.noop) console.log(`specrails-core@${version} is already stable; nothing to do`)
    else {
      const ci = await assertTagCiGreen({ version, repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN })
      console.log(`specrails-core@${version}: published ${verdict.ageDays.toFixed(1)} days ago with no follow-up patch, CI run ${ci.runId} green at ${ci.sha}`)
      if (dryRun) console.log(`Dry run: would run npm dist-tag add specrails-core@${version} stable`)
      else {
        npm(['dist-tag', 'add', `specrails-core@${version}`, 'stable'], { timeout: 120_000 })
        const tags = JSON.parse(npm(['view', 'specrails-core', 'dist-tags', '--json']))
        if (tags.stable !== version) throw new Error(`npm reports stable=${tags.stable} after promotion`)
        console.log(`Promoted specrails-core@${version} to stable`)
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
