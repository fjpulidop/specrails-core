import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { artifactPath, OpenSpecCommandError, resolveOpenSpecCli, runOpenSpec } from '../openspec.js'

export type ArchivePreflight = { valid: true } | { valid: false; reason: string }

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

function assertNoSymlinks(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('OpenSpec archive refuses symlink trees')
    if (entry.isDirectory()) assertNoSymlinks(path.join(root, entry.name))
  }
}

/**
 * Dry-runs `openspec archive` on a disposable copy of `openspec/`, so a change that validates but
 * cannot be archived is caught while its author can still edit the plan. Delta validation does not
 * check deltas against the main specs; archive rejects a MODIFIED or RENAMED requirement the main
 * spec lacks and an ADDED one it already has. Nothing in the artifact root is written.
 */
export async function previewOpenSpecArchive(artifactRoot: string, change: string, signal?: AbortSignal): Promise<ArchivePreflight> {
  const source = artifactPath(artifactRoot, 'openspec')
  assertNoSymlinks(source)
  const staging = mkdtempSync(path.join(os.tmpdir(), 'specrails-archive-preflight-'))
  try {
    cpSync(source, path.join(staging, 'openspec'), { recursive: true })
    let output: string
    try { output = await runOpenSpec(resolveOpenSpecCli(), staging, ['archive', change, '--yes'], signal) }
    catch (error) {
      if (!(error instanceof OpenSpecCommandError) || error.exitCode === undefined || error.exitCode < 1) throw error
      output = `${error.stdout}\n${error.message}`
    }
    const archiveRoot = path.join(staging, 'openspec/changes/archive')
    const archived = existsSync(archiveRoot) && readdirSync(archiveRoot).some(name => name.endsWith('-' + change))
    if (archived && !existsSync(path.join(staging, 'openspec/changes', change))) return { valid: true }
    const reason = output.replace(ANSI, '').split('\n').map(line => line.trimEnd()).filter(Boolean).join('\n').slice(-2000)
    return { valid: false, reason }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Main specs that predate OpenSpec's format, named from `openspec archive` output: a free-form spec
 * with no `## Purpose` section, or with requirement headers outside a `## Requirements` section.
 * No delta can repair either, and the planning role may not edit main specs. Other rebuilt-spec
 * failures (a requirement with no SHALL/MUST body, a missing scenario) are repairable and stay out.
 * OpenSpec stops at the first unwritable spec, so a second legacy target surfaces on the next run.
 */
export function legacyMainSpecs(reason: string): string[] {
  const names = new Set<string>()
  const lines = reason.split('\n')
  lines.forEach((line, index) => {
    const rebuilt = /^Validation errors in rebuilt spec for (\S+) \(will not write changes\):$/.exec(line)
    const structural = /^(\S+): target spec is structurally invalid\b/.exec(line)
    if (!rebuilt && !structural) return
    const block: string[] = []
    for (const next of lines.slice(index + 1)) {
      if (/^(Aborted\.|Validation errors in rebuilt spec for )/.test(next) || /^\S+: target spec is structurally invalid\b/.test(next)) break
      block.push(next)
    }
    const legacy = rebuilt
      ? block.some(item => /^\s*✗ .*(must have a Purpose section|must have a Requirements section|Missing required sections\. Expected headers: "## Purpose")/.test(item))
      : block.some(item => item.includes('outside the main ## Requirements section'))
    if (legacy) names.add((rebuilt ?? structural)![1].replace(/:$/, ''))
  })
  return [...names]
}

/** Plain-text guidance for the planning role's history. */
export function describeArchivePreflight(change: string, preflight: Extract<ArchivePreflight, { valid: false }>): string {
  const legacy = legacyMainSpecs(preflight.reason)
  return [
    `OpenSpec validates change ${change}, but archiving it would fail. OpenSpec's archive output:`,
    preflight.reason,
    legacy.length
      ? `The main spec${legacy.length > 1 ? 's' : ''} ${legacy.map(name => `openspec/specs/${name}/spec.md`).join(', ')} predate${legacy.length > 1 ? '' : 's'} OpenSpec's format (no ## Purpose or ## Requirements section), and no delta can repair that. Do not edit main specs and do not target ${legacy.join(', ')}: move these requirements to a delta for a new capability (openspec/changes/${change}/specs/<new-capability>/spec.md with only ## ADDED Requirements) and delete the delta that targeted ${legacy.length > 1 ? 'them' : 'it'}. OpenSpec stops at the first such spec, so check every other main spec you target the same way.`
      : 'Reconcile each delta with openspec/specs: MODIFIED and RENAMED headers must name an existing requirement exactly, and ADDED requirements must not exist yet.',
  ].join('\n')
}
