import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentResult } from '../executor-types.js'
import { artifactPath, type OpenSpecApply, type OpenSpecStatus } from '../openspec.js'
import { REVIEW_OUTPUT_SCHEMA } from '../prompts.js'
import { REVIEW_ASPECTS } from '../graph/review-policy.js'
import { hasBinaryAssets } from './architect.js'
import { bounded } from './prompt-inputs.js'
import { finalJson, openspecCall, strings, text, toolStep, type CompactEnv } from './step.js'

/** Tool calls the reviewer may spend inspecting beyond the supplied diff. */
const DEFAULT_REVIEW_TOOL_BUDGET = 15
/** A re-review only opens the changed files. */
const RE_REVIEW_TOOL_BUDGET = 6
const DIFF_LIMIT = 40 * 1024
const UNTRACKED_LIMIT = 8 * 1024
const MAX_UNTRACKED = 12

/** Working-tree changes of every allowed root against HEAD, plus the content of new files, bounded. `only` restricts the diff and the new-file listing to those repository-relative paths (a re-review reads just what the fixer touched). */
function collectDiff(roots: string[], only?: readonly string[]): string {
  // Pathspec magic stays enabled so openspec/ artifacts are excluded from the reviewed diff.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' }
  const options = { encoding: 'utf8' as const, env, windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }
  const sections: string[] = []
  let remaining = DIFF_LIMIT
  for (const root of roots) {
    const git = ['-c', 'core.fsmonitor=false', '-C', root]
    const scope = only?.length ? only.filter(file => !file.startsWith('openspec/')) : ['.']
    if (only && !scope.length) { sections.push(`### ${root}\n(no reviewable files changed since the previous verdict)`); continue }
    const diff = spawnSync('git', [...git, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', ...scope, ...(only ? [] : [':(exclude)openspec'])], options)
    if (diff.error || diff.status !== 0) { sections.push(`### ${root}\nGit diff unavailable for this repository; inspect files with the tools.`); continue }
    const untracked = spawnSync('git', [...git, 'ls-files', '--others', '--exclude-standard', '--', ...scope], options)
    const files = untracked.status === 0 ? untracked.stdout.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('openspec/')) : []
    let body = diff.stdout.length > remaining ? diff.stdout.slice(0, remaining) + '\n…(diff truncated)' : diff.stdout
    remaining = Math.max(0, remaining - body.length)
    for (const file of files.slice(0, MAX_UNTRACKED)) {
      let content = ''
      try { content = readFileSync(path.join(root, file), 'utf8') } catch { continue }
      if (content.includes('\0')) continue
      const shown = content.length > UNTRACKED_LIMIT ? content.slice(0, UNTRACKED_LIMIT) + '\n…(file truncated)' : content
      if (remaining <= 0) { body += `\n+++ new file: ${file} (omitted: diff budget spent)`; continue }
      body += `\n+++ new file: ${file}\n${shown}`
      remaining = Math.max(0, remaining - shown.length)
    }
    if (files.length > MAX_UNTRACKED) body += `\n(${files.length - MAX_UNTRACKED} more new files not shown)`
    sections.push(`### ${root}\n${body.trim() || '(no changes)'}`)
  }
  return sections.join('\n\n')
}
/** The gate thresholds the host rendered into the reviewer prompt (`score is at least N`, `aspect ≥ N`). */
function reviewGateThresholds(gate: string): { minScore: number; aspects: Record<string, number> } {
  const minScore = Number(/score\` is at least (\d+)/.exec(gate)?.[1] ?? 0)
  const aspects: Record<string, number> = {}
  for (const match of gate.matchAll(/`([a-z_]+)` ≥ (\d+)/g)) aspects[match[1]!] = Number(match[2])
  return { minScore, aspects }
}
/** Files named by the previous review's issues (`path: what must change` lines under `## Previous review`). */
function previousIssueFiles(feedback: string): string[] {
  const section = feedback.split('## Previous review')[1] ?? ''
  return [...new Set([...section.matchAll(/(?:^|[\s-])((?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|vue|svelte|html|css|scss|json|ya?ml|md))(?=[\s:,;)]|$)/g)].map(match => match[1]!.replace(/\\/g, '/')))]
}
function readArtifact(status: OpenSpecStatus, name: string): string {
  try { return readFileSync(artifactPath(status.changeRoot, name), 'utf8') } catch { return '' }
}
function clampScore(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0 }

/**
 * The compact reviewer: the host supplies the diff and the frozen criteria, the
 * model inspects read-only within a small budget, and the verdict is forced
 * into REVIEW_OUTPUT_SCHEMA. Missing criteria are recorded as pending, never
 * invented as met.
 */
export async function runCompactReviewer(env: CompactEnv, options: { reviewToolBudget?: number } = {}): Promise<AgentResult> {
  const loaded = await openspecCall(env, { action: 'load_skill' }) as { planning?: { status: OpenSpecStatus; apply: OpenSpecApply } }
  const status = loaded.planning?.status ?? await openspecCall(env, { action: 'status' }) as OpenSpecStatus
  const criteria = env.inputs.criteria
  // A re-review after a correction round: the diff covers only the files the
  // fixer touched and the stance is "settle your previous issues", not "review
  // the candidate again" (observed: three full passes, the second one adding
  // an issue to code verify had just accepted).
  const reReview = env.inputs.reReviewChanges
  const diff = collectDiff(env.toolset.roots, reReview.length ? reReview.map(item => item.path) : undefined)
  const stance = reReview.length
    ? `Re-review an implementation read-only after a correction round. Your previous review and its issues are supplied; the diff shows ONLY the files changed since then. For each previous issue state whether it is resolved; raise a new issue only for a regression inside these changed lines — never for code you already accepted. Certify every listed criterion: keep the ones you certified as met last time unless a changed file affects them. Use the tools only for the changed files. Do not modify anything.`
    : `Review an implementation read-only. The diff and the acceptance criteria are supplied; use the tools only to open files the diff references when the diff alone is not enough. Do not modify anything. Judge behaviour against the acceptance criteria, not the code's shape against the plan's wording: module layout, file lists, class/function/SFX names and techniques named in the ticket, design or contract layer are suggestions — a working implementation that meets a criterion another way is correct, and "rename/move/rewrite to match the plan" is never an issue (observed: six such issues, zero real defects).`
  if (reReview.length) env.onEvent?.({ kind: 'text', text: `Compact reviewer: re-review of ${reReview.length} changed file${reReview.length === 1 ? '' : 's'} (${reReview.map(item => item.path).slice(0, 6).join(', ')}${reReview.length > 6 ? ', …' : ''}).` })
  const changed = new Set(reReview.map(item => item.path.replace(/\\/g, '/')))
  // Reviewers are not told about binary assets (the architect is): without
  // this fact a spec that mentions "assets/audio/*.wav" makes the reviewer
  // demand files nobody can produce and reject runtime synthesis (observed:
  // "replace oscillator synthesis with static assets; create placeholder .wav
  // files" — issues the fixer cannot satisfy, score 60 after a green verify).
  const assetsFact = hasBinaryAssets(env.toolset.roots) ? '' : ' The repository contains no binary assets (audio, images, fonts) and none can be added — the implementer has no shell; effects produced at runtime by code (Web Audio API, canvas) SATISFY any spec wording about sound or image files, and asking for asset files is not a valid issue.'
  const loop = await toolStep(env, {
    system: `${stance}${assetsFact} Finish with one JSON object matching the review contract: {"approved":boolean,"summary":"","issues":["file: what must change"],"score":0-100,"aspects":{${REVIEW_ASPECTS.map(name => `"${name}":0-100`).join(',')}},"acceptance":{"criteria":[{"specId":"<id>","criterionIndex":0,"status":"met|blocked|pending","evidence":["file or test proving it"]}],"checks":[],"findings":[]}}. Certify EVERY listed criterion by its exact specId and criterionIndex; use "met" only when the diff proves it. ${env.inputs.reviewGate}`,
    user: [
      `Requested work (frozen scope):\n${bounded(env.inputs.scope, 2500)}`,
      `Acceptance criteria to certify:\n${criteria.map(item => `- specId "${item.specId}", criterionIndex ${item.criterionIndex}: ${item.requirement}`).join('\n') || '- (none listed)'}`,
      `tasks.md:\n${bounded(readArtifact(status, 'tasks.md'), 2000)}`,
      ...(env.inputs.developerSummary ? [`Developer summary (a claim to verify):\n${bounded(env.inputs.developerSummary, 2500)}`] : []),
      ...(env.inputs.feedback ? [`Verification result from the host:\n${bounded(env.inputs.feedback, 3000)}`] : []),
      reReview.length ? `Diff of the files changed since your previous verdict:\n${diff}` : `Diff against HEAD:\n${diff}`,
    ].join('\n\n'),
    tools: ['read_file', 'list_files'], maxToolCalls: options.reviewToolBudget ?? (reReview.length ? RE_REVIEW_TOOL_BUDGET : DEFAULT_REVIEW_TOOL_BUDGET),
    // A re-review reads the changed files and nothing else: the instruction
    // alone did not hold (observed: every file re-read, then new objections).
    ...(reReview.length ? { execute: async (name, args) => {
      if (name === 'read_file' && typeof args.path === 'string' && !changed.has(args.path.replace(/\\/g, '/'))) return JSON.stringify({ error: `"${args.path}" did not change since your previous verdict; this re-review covers only ${[...changed].join(', ')}. Judge the previous issues on those files and reply.` })
      return env.toolset.execute(name, args)
    } } : {}),
  })
  const raw = await finalJson(env, 'review', loop.messages, loop.text, REVIEW_OUTPUT_SCHEMA, value => typeof value.approved === 'boolean' && text(value.summary) ? undefined : '"approved" must be a boolean and "summary" a non-empty string')
  const aspectsRaw = raw.aspects && typeof raw.aspects === 'object' && !Array.isArray(raw.aspects) ? raw.aspects as Record<string, unknown> : {}
  const acceptanceRaw = raw.acceptance && typeof raw.acceptance === 'object' && !Array.isArray(raw.acceptance) ? raw.acceptance as Record<string, unknown> : {}
  const rows = (Array.isArray(acceptanceRaw.criteria) ? acceptanceRaw.criteria : []).flatMap(item => {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
    if (!entry) return []
    const evidence = strings(entry.evidence, 10, 500)
    const state = ['met', 'blocked', 'pending'].includes(String(entry.status)) ? String(entry.status) : 'pending'
    return [{ specId: String(entry.specId), criterionIndex: Number(entry.criterionIndex), status: state, evidence: evidence.length ? evidence : ['No evidence given by the reviewer'] }]
  })
  let issues = strings(raw.issues, 50, 1000)
  // On a re-review the host owns the scope: an issue that names none of the
  // changed files and none of the previous issues' files is a NEW objection to
  // code the reviewer already accepted — dropped, logged, never sent to the fixer.
  if (reReview.length) {
    const previous = previousIssueFiles(env.inputs.feedback)
    const allowed = [...changed, ...previous]
    const kept = issues.filter(issue => allowed.some(file => issue.includes(file) || issue.includes(path.basename(file))))
    const dropped = issues.filter(issue => !kept.includes(issue))
    if (dropped.length) env.onEvent?.({ kind: 'text', text: `Compact reviewer: dropped ${dropped.length} re-review issue${dropped.length === 1 ? '' : 's'} about code that did not change since the previous verdict (${dropped.map(item => JSON.stringify(item.slice(0, 80))).join('; ')}).` })
    issues = kept
  }
  const certified = criteria.map(item => rows.find(row => row.specId === item.specId && row.criterionIndex === item.criterionIndex) ?? { specId: item.specId, criterionIndex: item.criterionIndex, status: 'pending', evidence: ['The reviewer did not certify this criterion'] })
  const uncertified = certified.filter(row => row.status !== 'met').length
  if (uncertified && raw.approved === true) issues.push(`Review incomplete: ${uncertified} acceptance criteri${uncertified === 1 ? 'on' : 'a'} not certified as met.`)
  // After the host filter a re-review with no surviving issue and every
  // criterion met IS an approval, whatever the model's own flag or score said:
  // a fix round cannot make an already-reviewed candidate worse, and the
  // score of a reviewer that was refused the files it wanted is not evidence.
  const resolved = reReview.length > 0 && !uncertified && issues.length === 0
  const gate = resolved ? reviewGateThresholds(env.inputs.reviewGate) : undefined
  const lift = (value: unknown, floor: number | undefined): number => floor === undefined ? clampScore(value) : Math.max(clampScore(value), floor)
  if (resolved) env.onEvent?.({ kind: 'text', text: 'Compact reviewer: every previous issue is settled and every criterion certified; the re-review approves.' })
  const structured = {
    approved: (raw.approved === true || resolved) && !uncertified && issues.length === 0,
    summary: text(raw.summary).slice(0, 8000), issues, score: lift(raw.score, gate?.minScore),
    aspects: Object.fromEntries(REVIEW_ASPECTS.map(name => [name, lift(aspectsRaw[name], gate?.aspects[name])])),
    acceptance: { criteria: certified, checks: [], findings: strings(acceptanceRaw.findings, 50, 1000) },
  }
  return { text: JSON.stringify(structured), usage: env.client.usage, structured }
}
