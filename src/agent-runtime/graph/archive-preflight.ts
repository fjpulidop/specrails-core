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

/** Plain-text guidance for the planning role's history. */
export function describeArchivePreflight(change: string, preflight: Extract<ArchivePreflight, { valid: false }>): string {
  return [
    `OpenSpec validates change ${change}, but archiving it would fail. OpenSpec's archive output:`,
    preflight.reason,
    'Reconcile each delta with openspec/specs: MODIFIED and RENAMED headers must name an existing requirement exactly, and ADDED requirements must not exist yet.',
  ].join('\n')
}
