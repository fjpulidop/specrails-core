import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RuntimeIdentity {
  packageVersion: string
  workflowVersion: string
  instructionsVersion: string
  packageIntegrity: string
  apiVersion: 1
}
/** Hash the executable package, not a mutable path or its advertised version.
 * Dependencies are retained/verified by the host package snapshot separately. */
export function runtimePackageIntegrity(root = fileURLToPath(new URL('../../', import.meta.url))): string {
  const hash = createHash('sha256')
  const visit = (relative: string): void => {
    const file = path.join(root, relative)
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('Runtime package contains an unsupported symbolic link: ' + relative)
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(path.posix.join(relative, name))
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, stat.size])).update('\0').update(readFileSync(file)).update('\0')
    } else throw new Error('Runtime package contains a nonregular file: ' + relative)
  }
  for (const entry of ['package.json', 'dist', 'bin', 'templates', 'schemas', 'commands', 'integration-contract.json', 'pinned-versions.json']) {
    if (existsSync(path.join(root, entry))) visit(entry)
  }
  return 'sha256:' + hash.digest('hex')
}

export function sameRuntimeIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return ['packageVersion', 'workflowVersion', 'instructionsVersion', 'packageIntegrity', 'apiVersion'].every(key => left[key as keyof RuntimeIdentity] === right[key as keyof RuntimeIdentity])
}
