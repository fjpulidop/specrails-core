import path from 'node:path'

import { InstallerError } from '../util/errors.js'
import { isDir, pathExists } from '../util/fs.js'
import { readRegistryOrEmpty } from '../util/registry.js'

import {
  derivedPaths,
  type Provider,
} from './provider-detect.js'
import {
  ensureCurrentSymlink,
  frameworkMaterializationProblem,
  frameworkStampPath,
  installFramework,
} from './scaffold.js'

/**
 * Stable provider order for the global framework store. `framework/current` is
 * shared by every relocated workspace, so a version transition must carry
 * forward every provider that can still have live links through that pointer.
 */
export const FRAMEWORK_PROVIDERS: readonly Provider[] = [
  'claude',
  'codex',
  'gemini',
  'kimi',
]

export interface ResolveRequiredFrameworkProvidersInput {
  frameworkDir: string
  /** Providers requested by the lifecycle operation that is about to swap. */
  requested?: readonly Provider[]
  /** Registry home. Defaults to SPECRAILS_REGISTRY_HOME / the normal home. */
  registryHome?: string
}

export interface MaterializeFrameworkVersionInput
  extends ResolveRequiredFrameworkProvidersInput {
  scriptDir: string
  version: string
}

function isProvider(value: unknown): value is Provider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'gemini' ||
    value === 'kimi'
  )
}

function stableProviders(values: Iterable<Provider>): Provider[] {
  const wanted = new Set(values)
  return FRAMEWORK_PROVIDERS.filter((provider) => wanted.has(provider))
}

/**
 * Discover providers represented by a framework version.
 *
 * A provider is included when either its subtree or its stamp exists. For the
 * current version this is deliberately conservative: an interrupted/legacy
 * materialization without a stamp may still have live workspace symlinks, so
 * the next version must carry that provider forward rather than dropping it.
 */
export function discoverFrameworkProviders(
  frameworkDir: string,
  version: string,
): Provider[] {
  const versionDir = path.join(frameworkDir, version)
  return FRAMEWORK_PROVIDERS.filter((provider) => {
    const { providerDir } = derivedPaths(provider)
    return (
      pathExists(path.join(versionDir, providerDir)) ||
      pathExists(frameworkStampPath(versionDir, providerDir))
    )
  })
}

/**
 * Compute the provider set that MUST exist in a destination version before the
 * process may move the global `current` pointer:
 *
 *  1. providers requested by this operation;
 *  2. every supported provider recorded by any project in registry.json;
 *  3. every provider represented by the version currently serving workspaces.
 *
 * Taking the global registry union (not just the active project) is essential:
 * `framework/current` is global, while provider inventories are per project.
 */
export function resolveRequiredFrameworkProviders(
  input: ResolveRequiredFrameworkProvidersInput,
): Provider[] {
  const required = new Set<Provider>(input.requested ?? [])

  const registry = readRegistryOrEmpty(input.registryHome)
  for (const entry of Object.values(registry.projects)) {
    for (const provider of entry.providers ?? []) {
      if (isProvider(provider)) required.add(provider)
    }
    if (isProvider(entry.primaryProvider)) required.add(entry.primaryProvider)
  }

  for (const provider of discoverFrameworkProviders(input.frameworkDir, 'current')) {
    required.add(provider)
  }

  return stableProviders(required)
}

/**
 * Fail closed when a destination version is missing or only partially
 * materialized. A valid provider requires BOTH its provider subtree and the
 * final stamp written after scaffold completion, with matching version/provider
 * fields. The caller may supply an empty requirement only for a first install;
 * in that case at least one complete provider must be discoverable in target.
 */
export function assertFrameworkVersionComplete(
  frameworkDir: string,
  version: string,
  requiredProviders: readonly Provider[],
): Provider[] {
  const versionDir = path.join(frameworkDir, version)
  if (!isDir(versionDir)) {
    throw new InstallerError(
      `framework version ${version} is not materialized at ${versionDir}`,
      41,
    )
  }

  const required =
    requiredProviders.length > 0
      ? stableProviders(requiredProviders)
      : discoverFrameworkProviders(frameworkDir, version)

  if (required.length === 0) {
    throw new InstallerError(
      `framework version ${version} is incomplete: no provider was materialized`,
      41,
    )
  }

  const problems: string[] = []
  for (const provider of required) {
    const { providerDir } = derivedPaths(provider)
    const problem = frameworkMaterializationProblem(
      versionDir,
      version,
      provider,
      providerDir,
    )
    if (problem) problems.push(`${provider}: ${problem}`)
  }

  if (problems.length > 0) {
    throw new InstallerError(
      `framework version ${version} is incomplete; refusing to move current: ` +
        problems.join('; '),
      41,
    )
  }

  return required
}

/**
 * Materialize a complete destination version and expose it with ONE atomic
 * pointer swap. No call in the provider loop can move `current`; if any provider
 * fails, existing workspaces continue resolving through the previous version.
 */
export function materializeFrameworkVersion(
  input: MaterializeFrameworkVersionInput,
): Provider[] {
  const required = resolveRequiredFrameworkProviders(input)
  if (required.length === 0) {
    throw new InstallerError(
      `framework version ${input.version} has no requested or registered provider`,
      41,
    )
  }

  for (const provider of required) {
    installFramework({
      scriptDir: input.scriptDir,
      frameworkDir: input.frameworkDir,
      provider,
      providerDir: derivedPaths(provider).providerDir,
      version: input.version,
    })
  }

  assertFrameworkVersionComplete(input.frameworkDir, input.version, required)
  ensureCurrentSymlink(input.frameworkDir, input.version)
  return required
}
