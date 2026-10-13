import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { artifactPath, OpenSpecCommandError, resolveOpenSpecCli, runOpenSpec } from '../openspec.js'

export interface ArchiveRequirementFinding { path: string; line: number; requirement: string }
export type ArchivePreflight = { valid: true } | { valid: false; reason: string; findings: ArchiveRequirementFinding[] }

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

/**
 * Requirements OpenSpec rejects when it rebuilds a main spec on archive: its spec parser reads only
 * the first non-empty body line before any heading and needs SHALL or MUST there. Delta validation
 * skips `**Key**:` metadata lines, so a delta (or a pre-existing main-spec requirement) can pass
 * `openspec validate` and still abort the archive.
 */
export function requirementsWithoutKeyword(markdown: string): Array<{ line: number; requirement: string }> {
  const lines = markdown.split('\n'), findings: Array<{ line: number; requirement: string }> = []
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index]!.match(/^###\s+Requirement:\s*(.*)$/)
    if (!header) continue
    let body: number | undefined
    for (let next = index + 1; next < lines.length; next++) {
      const text = lines[next]!.trim()
      if (text.startsWith('#')) break
      if (text) { body = next; break }
    }
    const text = body === undefined ? header[1]! : lines[body]!
    if (!text.includes('SHALL') && !text.includes('MUST')) findings.push({ line: (body ?? index) + 1, requirement: header[1]!.trim() })
  }
  return findings
}

function assertNoSymlinks(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('OpenSpec archive refuses symlink trees')
    if (entry.isDirectory()) assertNoSymlinks(path.join(root, entry.name))
  }
}

function capabilityFindings(artifactRoot: string, change: string): ArchiveRequirementFinding[] {
  const deltas = path.join(artifactRoot, 'openspec/changes', change, 'specs')
  if (!existsSync(deltas)) return []
  const findings: ArchiveRequirementFinding[] = []
  for (const capability of readdirSync(deltas).sort()) {
    for (const relative of [`openspec/changes/${change}/specs/${capability}/spec.md`, `openspec/specs/${capability}/spec.md`]) {
      const file = path.join(artifactRoot, relative)
      if (!existsSync(file) || !lstatSync(file).isFile()) continue
      for (const finding of requirementsWithoutKeyword(readFileSync(file, 'utf8'))) findings.push({ path: relative, ...finding })
    }
  }
  return findings
}

/**
 * Dry-runs `openspec archive` on a disposable copy of `openspec/`, so a change that validates but
 * cannot be archived is caught while its author can still edit the plan. Nothing in the
 * artifact root is written.
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
    return { valid: false, reason, findings: capabilityFindings(artifactRoot, change) }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Plain-text guidance for the planning role's history. */
export function describeArchivePreflight(change: string, preflight: Extract<ArchivePreflight, { valid: false }>): string {
  const located = preflight.findings.map(finding => `- ${finding.path}:${finding.line} "${finding.requirement}"`).join('\n')
  return [
    `OpenSpec validates change ${change}, but archiving it would fail. OpenSpec's archive output:`,
    preflight.reason,
    ...(located ? ['Requirements whose first body line has no SHALL or MUST (OpenSpec reads only that line when it rebuilds a main spec):', located,
      'Put the SHALL/MUST statement on the line right after "### Requirement: …". For a requirement that only exists in openspec/specs, restate it under "## MODIFIED Requirements" in this change\'s delta with the corrected first line.'] : []),
  ].join('\n')
}
