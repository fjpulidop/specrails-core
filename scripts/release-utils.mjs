import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function isMain(meta) {
  return Boolean(process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === meta)
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options })
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`)}`)
  return result.stdout.trim()
}
// Run npm's JavaScript entry point, including on Windows; no cmd.exe quoting.
export function npmCli(env = process.env) {
  const candidates = [env.npm_execpath]
  for (const dir of [path.dirname(process.execPath), ...(env.PATH ?? env.Path ?? '').split(path.delimiter)]) {
    candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.join(dir, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(dir, 'npm'))
  }
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue
    const resolved = realpathSync(file)
    if (resolved.endsWith('npm-cli.js')) return resolved
  }
  throw new Error('Cannot locate npm-cli.js for the active Node installation')
}
export function npm(args, options = {}) { return run(process.execPath, [npmCli(), ...args], options) }
export function integrity(bytes) { return 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
export function releaseVersion(tag) {
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('Release tag must be an existing stable vX.Y.Z tag')
  return tag.slice(1)
}
export function validateVersions(version, pkg, lock, releaseManifest) {
  if (pkg.name !== 'specrails-core' || pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version || releaseManifest['.'] !== version) {
    throw new Error('Tag, package.json, package-lock.json and release-please manifest versions must agree')
  }
}
export function validateRelease(root, tag, expectedSha) {
  const version = releaseVersion(tag)
  const git = (...args) => run('git', ['-C', root, ...args])
  const sha = git('rev-parse', 'HEAD')
  if (git('rev-parse', `refs/tags/${tag}^{commit}`) !== sha || (expectedSha && sha !== expectedSha)) throw new Error('Release tag does not point at the tested commit')
  git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main')
  const json = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'))
  validateVersions(version, json('package.json'), json('package-lock.json'), json('.release-please-manifest.json'))
  return { version, sha }
}
export function validateArtifact(manifest, bytes, expected) {
  if (manifest.schemaVersion !== 1 || manifest.name !== 'specrails-core' || manifest.version !== expected.version || manifest.sha !== expected.sha) throw new Error('Package artifact identity differs from release')
  if (!/^specrails-core-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\.tgz$/.test(manifest.filename)) throw new Error('Unsafe package artifact filename')
  if (manifest.integrity !== integrity(bytes)) throw new Error('Package artifact integrity mismatch')
  return manifest
}
export function validatePackFiles(files) {
  const names = new Set(files.map((file) => file.path))
  for (const required of ['package.json', 'bin/specrails-core.mjs', 'dist/installer/cli.js', 'dist/pipeline/pipeline-state.js', 'integration-contract.json', 'pinned-versions.json', 'schemas/agent-runtime.schema.json', 'templates/commands/specrails/implement.md']) {
    if (!names.has(required)) throw new Error(`Published package is missing ${required}`)
  }
  for (const name of names) {
    if (typeof name !== 'string' || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || /(^|\/)(node_modules|\.git|\.specrails|\.env(?:\..*)?|id_rsa|id_ed25519)(\/|$)/.test(name)) throw new Error(`Unexpected private or unsafe package entry: ${name}`)
  }
}
