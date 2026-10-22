/**
 * Pure, deterministic coverage rules of the `derive-change` piece. The model
 * writes design.md; only this code decides which changed files it explains.
 */

export interface CoverageFile { repositoryId: string; path: string }
export interface Coverage { explained: CoverageFile[]; unexplained: CoverageFile[] }

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/
/** A character that can continue a path: a match bordered by one is part of a longer path. */
const PATH_CHAR = /[\p{L}\p{N}_\-./\\@+~$%=]/u

/** The body of design.md's `Blast radius` section (to the next heading of the same or a higher level), or undefined when absent. */
export function blastRadiusSection(design: string): string | undefined {
  const lines = design.normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
  let level = 0, start = -1, fenced = false
  for (let index = 0; index < lines.length; index++) {
    if (/^ {0,3}(```|~~~)/.test(lines[index])) fenced = !fenced
    if (fenced) continue
    const heading = HEADING.exec(lines[index])
    if (!heading) continue
    if (start >= 0 && heading[1].length <= level) return lines.slice(start, index).join('\n')
    if (start < 0 && /^(?:\d+[.)]\s*)?(?:\*\*|__)?blast radius\b/i.test(heading[2])) { level = heading[1].length; start = index + 1 }
  }
  return start >= 0 ? lines.slice(start).join('\n') : undefined
}

/** Whether `needle` occurs in `text` as a whole path: not preceded or followed by more path characters (a trailing sentence period is allowed). */
function containsPath(text: string, needle: string): boolean {
  if (!needle) return false
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = at > 0 ? text[at - 1] : '', after = text[at + needle.length] ?? '', next = text[at + needle.length + 1] ?? ''
    if (before && PATH_CHAR.test(before)) continue
    if (after && PATH_CHAR.test(after) && !(after === '.' && !(next && PATH_CHAR.test(next)))) continue
    return true
  }
  return false
}

/** Markdown backslash escapes (`my\_file.ts`) do not change the path the author meant. */
function unescapeMarkdown(text: string): string { return text.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, '$1') }

/**
 * Splits the change set into files design.md's Blast radius names and files it
 * does not. A file is named by its repository-relative path; with several
 * repositories `<repositoryId>/<path>` and `<repositoryId>:<path>` also count.
 * Without the section every file is unexplained.
 */
export function blastRadiusCoverage(design: string, files: readonly CoverageFile[], multiple: boolean): Coverage {
  const section = blastRadiusSection(design)
  const coverage: Coverage = { explained: [], unexplained: [] }
  const texts = section === undefined ? [] : [section, unescapeMarkdown(section)]
  for (const file of files) {
    const path = file.path.normalize('NFC')
    const candidates = [path, './' + path, path.replaceAll('/', '\\'), ...(multiple ? [file.repositoryId + '/' + path, file.repositoryId + ':' + path] : [])]
    const named = texts.some(text => candidates.some(candidate => containsPath(text, candidate)))
    ;(named ? coverage.explained : coverage.unexplained).push(file)
  }
  return coverage
}

/** How a changed file is reported in derivation.json: its path, prefixed by `<repositoryId>:` when the run spans several repositories. */
export function coverageLabel(file: CoverageFile, multiple: boolean): string { return multiple ? file.repositoryId + ':' + file.path : file.path }

/** Requirements the change's delta specs add and modify (`### Requirement:` under `## ADDED` / `## MODIFIED Requirements`). */
export function countRequirements(specs: readonly string[]): { added: number; modified: number } {
  const counts = { added: 0, modified: 0 }
  for (const spec of specs) {
    let section: 'added' | 'modified' | undefined, fenced = false
    for (const line of spec.replace(/\r\n?/g, '\n').split('\n')) {
      if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced
      if (fenced) continue
      const delta = /^##[ \t]+(ADDED|MODIFIED|REMOVED|RENAMED)[ \t]+Requirements\b/i.exec(line)
      if (delta) { section = delta[1].toUpperCase() === 'ADDED' ? 'added' : delta[1].toUpperCase() === 'MODIFIED' ? 'modified' : undefined; continue }
      if (/^##[ \t]/.test(line)) { section = undefined; continue }
      if (section && /^###[ \t]+Requirement:/.test(line)) counts[section]++
    }
  }
  return counts
}

/** `transcriptTurns: <n>` from the summary's leading front matter (written by the host), else 0. */
export function transcriptTurns(summary: string): number {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(summary)
  const value = front ? /^transcriptTurns:[ \t]*(\d{1,9})[ \t]*$/m.exec(front[1]) : null
  return value ? Number(value[1]) : 0
}
