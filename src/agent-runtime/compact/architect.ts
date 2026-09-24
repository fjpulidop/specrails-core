import { languageProfile } from './developer.js'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { AgentResult } from '../executor-types.js'
import type { OpenSpecStatus } from '../openspec.js'
import { bounded } from './prompt-inputs.js'
import { finalJson, openspecCall, strings, structuredStep, text, toolStep, type CompactEnv , PLANNING_CONTROLS, on } from './step.js'

const MAX_CAPABILITIES = 6
const MAX_TASKS = 9
const MIN_TASKS = 4
/** A task that names a path under openspec/ would make the developer mutate frozen artifacts. */
const GENERIC_IDENTIFIERS = new Set(['number', 'string', 'boolean', 'null', 'undefined', 'void', 'object', 'array', 'true', 'false', 'seed', 'state', 'error', 'command', 'optional'])
/** The load-bearing tokens of a criterion: identifiers (`createGame`, `applyInput`, `tick`), numbers and hyphenated terms — never prose words. */
export function criterionTokens(text: string): string[] {
  const out = new Set<string>()
  // Identifiers inside backticks (`tick(state)` → tick, state; `createGame(seed?: number): GameState` → creategame, gamestate…).
  for (const match of text.matchAll(/`([^`]+)`/g)) for (const id of match[1]!.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) if (!GENERIC_IDENTIFIERS.has(id.toLowerCase())) out.add(id.toLowerCase())
  // camelCase / snake_case identifiers, calls, numbers and hyphenated terms in prose.
  for (const match of text.replace(/`[^`]+`/g, ' ').matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z]+_[a-z0-9_]+\b|\b[A-Za-z_][A-Za-z0-9_]*(?=\()|(?<![\w-])[a-z0-9]+-[a-z]+(?![\w-])|\b\d+(?:x\d+)?\b/g)) out.add(match[0].toLowerCase())
  return [...out].filter(token => token.length > 1)
}
/** A task that names at least one source/test file (not a document) — the plan must implement, not describe. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|vue|svelte|html|css|scss|sql|sh)\b/i
const STOP_WORDS = new Set(['that','with','from','this','when','then','into','each','must','shall','should','system','returns','return','state','after','before','their','which','every','only','also','than','have','been','game'])
const OPENSPEC_TARGET = /(?:^|[\s`'"(/\\])openspec[\/\\]/i
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NON_SOURCE = new Set(['openspec', 'README.md', 'README', 'LICENSE', 'LICENSE.md', '.gitignore', '.gitattributes', '.editorconfig', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.DS_Store'])
const HIDDEN = /^\./

interface Inventory { greenfield: boolean; languages: string[]; frameworks: string[]; keyFiles: string[]; tests: string[]; notes: string }
interface Proposal { why: string; whatChanges: string[]; capabilities: { new: string[]; modified: string[] }; impact: string[] }
interface Design { context: string; goals: string[]; nonGoals: string[]; decisions: { title: string; choice: string; why: string }[]; risks: { risk: string; mitigation: string }[] }
interface Spec { name: string; requirements: { name: string; text: string; scenarios: { name: string; when: string; then: string }[] }[] }
interface Tasks { groups: { title: string; tasks: string[] }[]; verification: { repositoryId: string; command: string; args: string[] }[]; blockingQuestion?: string }

const stringList = { type: 'array', items: { type: 'string' } }
const INVENTORY_SCHEMA = { type: 'object', additionalProperties: false, required: ['greenfield', 'languages', 'frameworks', 'keyFiles', 'tests', 'notes'], properties: { greenfield: { type: 'boolean' }, languages: stringList, frameworks: stringList, keyFiles: stringList, tests: stringList, notes: { type: 'string' } } }
const PROPOSAL_SCHEMA = { type: 'object', additionalProperties: false, required: ['why', 'whatChanges', 'capabilities', 'impact'], properties: { why: { type: 'string' }, whatChanges: stringList, capabilities: { type: 'object', additionalProperties: false, required: ['new', 'modified'], properties: { new: stringList, modified: stringList } }, impact: stringList } }
const DESIGN_SCHEMA = { type: 'object', additionalProperties: false, required: ['context', 'goals', 'nonGoals', 'decisions', 'risks'], properties: { context: { type: 'string' }, goals: stringList, nonGoals: stringList, decisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'choice', 'why'], properties: { title: { type: 'string' }, choice: { type: 'string' }, why: { type: 'string' } } } }, risks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['risk', 'mitigation'], properties: { risk: { type: 'string' }, mitigation: { type: 'string' } } } } } }
const SPEC_SCHEMA = { type: 'object', additionalProperties: false, required: ['name', 'requirements'], properties: { name: { type: 'string' }, requirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'text', 'scenarios'], properties: { name: { type: 'string' }, text: { type: 'string' }, scenarios: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'when', 'then'], properties: { name: { type: 'string' }, when: { type: 'string' }, then: { type: 'string' } } } } } } } } }
/** Names the repository's primary language for the plan, so task file names use its extension (a greenfield repository has none yet). */
function languageLine(roots: readonly string[]): string {
  const profile = languageProfile(roots)
  return profile ? `\nPrimary language of the repository: ${profile.primary}${profile.others.length ? ` (also present: ${profile.others.join(', ')})` : ''} — name new source files with its extension.` : ''
}
const TASKS_SCHEMA = { type: 'object', additionalProperties: false, required: ['groups'], properties: { groups: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'tasks'], properties: { title: { type: 'string' }, tasks: stringList } } }, verification: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['repositoryId', 'command', 'args'], properties: { repositoryId: { type: 'string' }, command: { type: 'string' }, args: stringList } } }, blockingQuestion: { type: 'string' } } }

/** True when no repository holds anything but OpenSpec artifacts and repository boilerplate. */
function hostGreenfield(roots: string[]): boolean {
  return roots.every(root => {
    if (!existsSync(root)) return true
    return readdirSync(root).every(name => NON_SOURCE.has(name) || HIDDEN.test(name))
  })
}
function slug(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) }
function bullets(items: string[], fallback: string): string { return items.length ? items.map(item => `- ${item}`).join('\n') : `- ${fallback}` }
/** Rendered with the exact headings `openspec instructions proposal` returns. */
function renderProposal(proposal: Proposal, capabilityNames: { new: string[]; modified: string[] }): string {
  return ['## Why', '', proposal.why, '', '## What Changes', '', bullets(proposal.whatChanges, 'See the requirements in the specs of this change.'), '', '## Capabilities', '', '### New Capabilities',
    ...(capabilityNames.new.length ? capabilityNames.new.map(name => `- \`${name}\`: ${name.replace(/-/g, ' ')}`) : ['- (none)']), '', '### Modified Capabilities',
    ...(capabilityNames.modified.length ? capabilityNames.modified.map(name => `- \`${name}\`: requirements extended by this change`) : ['- (none)']), '', '## Impact', '', bullets(proposal.impact, 'Limited to the repositories in scope.'), ''].join('\n')
}
function renderDesign(design: Design, greenfield: boolean): string {
  return ['## Context', '', ...(greenfield ? ['The repository has no application code; the spec means building it from scratch.', ''] : []), design.context, '', '## Goals / Non-Goals', '', '**Goals:**', bullets(design.goals, 'Deliver the requested work.'), '', '**Non-Goals:**', bullets(design.nonGoals, 'Anything outside the frozen scope.'), '', '## Decisions', '',
    ...(design.decisions.length ? design.decisions.map(item => `- **${item.title}**: ${item.choice} — ${item.why}`) : ['- Follow the existing conventions of the repository.']), '', '## Risks / Trade-offs', '', ...(design.risks.length ? design.risks.map(item => `- [${item.risk}] → ${item.mitigation}`) : ['- [Scope creep] → implement only the listed tasks.']), '', '## Local reference patterns', '', greenfield ? 'No existing implementation to reference: the repository is empty.' : 'See the key files listed in the inventory of this change; no equivalent implementation was verified beyond them.', ''].join('\n')
}
/** Every requirement carries SHALL/MUST and at least one scenario, which `validate --strict` requires. */
const BINARY_ASSET_EXT = /\.(?:wav|mp3|ogg|flac|m4a|aac|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm)$/i
/** True when any media/font file exists under the roots (bounded walk, dot/dependency dirs skipped). */
export function hasBinaryAssets(roots: readonly string[], limit = 4000): boolean {
  let seen = 0
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 6 || seen > limit) return false
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return false }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'openspec' || entry.startsWith('.')) continue
      seen++
      const full = path.join(dir, entry)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }
      if (isDir ? walk(full, depth + 1) : BINARY_ASSET_EXT.test(entry)) return true
    }
    return false
  }
  return roots.some(root => walk(root, 0))
}
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'when', 'is', 'are', 'be', 'by', 'at', 'as', 'that', 'this', 'it', 'its', 'shall', 'must', 'system', 'should', 'will', 'from', 'into', 'than', 'then'])
function requirementTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(word => word.length > 2 && !STOP.has(word)))
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / (a.size + b.size - shared)
}
/**
 * One requirement lives in exactly one capability. A small model given
 * "write the requirements of capability X" restates the WHOLE ticket under
 * every capability (observed: 20 requirements for 8 obligations across
 * sound-effects / audio-controls / gameplay-events, three near-identical
 * lists). Later capabilities lose the requirements an earlier one already
 * holds (same normalized name, or ≥ 0.6 token overlap of the SHALL text);
 * a capability left empty is dropped. Returns the kept specs and the drops.
 */
export function dedupeSpecRequirements(specs: readonly Spec[]): { specs: Spec[]; dropped: Array<{ capability: string; requirement: string; keptIn: string }> } {
  const kept: Array<{ capability: string; name: string; tokens: Set<string> }> = []
  const dropped: Array<{ capability: string; requirement: string; keptIn: string }> = []
  const out: Spec[] = []
  for (const spec of specs) {
    const requirements = spec.requirements.filter(requirement => {
      const name = requirement.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      const tokens = requirementTokens(requirement.text)
      const twin = kept.find(item => item.name === name || jaccard(item.tokens, tokens) >= 0.6)
      if (twin) { dropped.push({ capability: spec.name, requirement: requirement.name, keptIn: twin.capability }); return false }
      kept.push({ capability: spec.name, name, tokens })
      return true
    })
    if (requirements.length) out.push({ name: spec.name, requirements })
  }
  return { specs: out, dropped }
}
/**
 * Every acceptance criterion of the ticket must reach a spec, or the plan
 * (which is validated against the specs) can legitimately skip it (observed:
 * the ticket listed soft-drop among the SFX actions; no spec mentioned it,
 * no task implemented it). Criteria with no identifier/number token in any
 * requirement text are appended verbatim to the best-matching capability,
 * as the requester's own words.
 */
export function coverCriteria(specs: Spec[], criteria: readonly string[]): { specs: Spec[]; added: string[] } {
  if (!specs.length) return { specs, added: [] }
  const haystack = specs.flatMap(spec => spec.requirements.map(item => `${item.name} ${item.text} ${item.scenarios.map(row => `${row.when} ${row.then}`).join(' ')}`)).join(' ').toLowerCase()
  const added: string[] = []
  for (const criterion of criteria) {
    const tokens = criterionTokens(criterion)
    const words = [...requirementTokens(criterion)]
    const covered = tokens.length ? tokens.some(token => haystack.includes(token)) : words.length === 0 || words.filter(word => haystack.includes(word)).length >= Math.ceil(words.length / 2)
    if (covered) continue
    const wordSet = requirementTokens(criterion)
    const target = specs.map(spec => ({ spec, score: jaccard(wordSet, requirementTokens(spec.requirements.map(item => item.text).join(' '))) })).sort((a, b) => b.score - a.score)[0]!.spec
    target.requirements.push({ name: criterion.slice(0, 80).replace(/[.:]+$/, ''), text: /(?:SHALL|MUST)/.test(criterion) ? criterion : `The system SHALL satisfy the requester's criterion: ${criterion}`, scenarios: [{ name: 'Requester criterion', when: 'the behaviour this criterion describes is exercised', then: criterion }] })
    added.push(criterion)
  }
  return { specs, added }
}
export function renderSpec(spec: Spec): string {
  const lines = ['## ADDED Requirements', '']
  for (const requirement of spec.requirements) {
    const body = /\b(?:SHALL|MUST)\b/.test(requirement.text) ? requirement.text : `The system SHALL satisfy the following: ${requirement.text}`
    lines.push(`### Requirement: ${requirement.name}`, body, '')
    for (const scenario of requirement.scenarios.length ? requirement.scenarios : [{ name: 'Requested behavior', when: 'the feature is used as specified', then: requirement.text }]) lines.push(`#### Scenario: ${scenario.name}`, `- **WHEN** ${scenario.when}`, `- **THEN** ${scenario.then}`, '')
  }
  return lines.join('\n')
}
export function renderTasks(groups: { title: string; tasks: string[] }[]): string {
  const lines: string[] = []
  groups.forEach((group, index) => {
    lines.push(`## ${index + 1}. ${group.title}`, '')
    group.tasks.forEach((task, taskIndex) => lines.push(`- [ ] ${index + 1}.${taskIndex + 1} ${task}`))
    lines.push('')
  })
  return lines.join('\n')
}
function normalizeSpec(raw: Record<string, unknown>, name: string): Spec {
  const requirements = (Array.isArray(raw.requirements) ? raw.requirements : []).flatMap(item => {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
    if (!entry || !text(entry.name) || !text(entry.text)) return []
    const scenarios = (Array.isArray(entry.scenarios) ? entry.scenarios : []).flatMap(scenario => {
      const row = scenario && typeof scenario === 'object' && !Array.isArray(scenario) ? scenario as Record<string, unknown> : undefined
      return row && text(row.when) && text(row.then) ? [{ name: text(row.name, 'Requested behavior'), when: text(row.when), then: text(row.then) }] : []
    }).slice(0, 8)
    return [{ name: text(entry.name).slice(0, 120), text: text(entry.text).slice(0, 2000), scenarios }]
  }).slice(0, 12)
  return { name, requirements }
}
/**
 * Rejects plans a small model tends to produce: tasks that "implement" by
 * writing next to the frozen OpenSpec plan (verify then fails with
 * "Architecture artifacts changed after design approval") and plans made only
 * of documents/specs. Returned text is fed back to the model for ONE retry.
 */
export function validateTaskPlan(value: Record<string, unknown>, repositories: string[], requirements: readonly string[] = []): string | undefined {
  const normalized = normalizeTasks(value, repositories)
  if (!normalized.groups.length) return 'at least one group with one task is required'
  const all = normalized.groups.flatMap(group => group.tasks)
  // A "task" must be a sentence of work, not a file name: small models answer
  // "package.json" / "src/index.js" when they resume a plan into a scaffold.
  const stubs = all.filter(task => task.trim().length < 25 || !/\s/.test(task.trim()))
  if (stubs.length) return `these tasks are file names or stubs, not units of work: ${stubs.map(task => JSON.stringify(task)).join(', ')}. Each task must say WHAT behaviour it implements, in WHICH files, with WHICH tests.`
  // Enough work to carry the requirements: a real spec never fits one group.
  if (requirements.length >= 3 && (all.length < 4 || normalized.groups.length < 2)) return `the plan has ${all.length} task(s) in ${normalized.groups.length} group(s) for ${requirements.length} requirements; break the work into at least 4 tasks across at least 2 groups (scaffold → domain model → game logic → integration/API → tests).`
  // Every requirement must be traceable to a task (by name words), or the
  // developer will legitimately ship a stub and the reviewer will reject it.
  const haystack = all.join(' ').toLowerCase()
  // Identifiers and numbers are the load-bearing tokens of a criterion
  // (`createGame`, `applyInput`, `7-bag`, `800`, `hold-piece-canvas`): a miss
  // on them is reliable, so ONE such requirement is enough to reject the plan
  // (observed: a `ui-rendering` spec with zero tasks shipped without the UI,
  // accepted under the old one-third tolerance). Prose-only matches stay
  // fuzzy — synonyms are common — and keep that tolerance.
  const identifiersOf = (text: string): string[] => [...new Set((text.match(/[A-Za-z_][A-Za-z0-9_]*(?:[A-Z][a-z0-9]+|_[a-z0-9]+)|\b\d+(?:x\d+)?\b|[a-z]+-[a-z]+/g) ?? []).map(token => token.toLowerCase()))]
  const uncoveredStrict = requirements.filter(text => { const identifiers = identifiersOf(text); return identifiers.length > 0 && !identifiers.some(token => haystack.includes(token)) })
  const uncoveredFuzzy = requirements.filter(text => {
    if (identifiersOf(text).length) return false
    const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3 && !STOP_WORDS.has(word))
    return words.length > 0 && !words.some(word => haystack.includes(word))
  })
  const uncovered = [...uncoveredStrict, ...uncoveredFuzzy]
  if (requirements.length >= 3 && (uncoveredStrict.length || uncoveredFuzzy.length > Math.floor(requirements.length / 3))) return `these requirements are not covered by any task: ${uncovered.map(name => JSON.stringify(name)).join(', ')}. Add tasks (with files and tests) that implement each of them.`
  const planning = all.filter(task => OPENSPEC_TARGET.test(task))
  if (planning.length) return `these tasks target the frozen OpenSpec planning directory instead of application code: ${planning.map(task => JSON.stringify(task.slice(0, 120))).join('; ')}. Name real source/test files (e.g. src/, tests/) for every task.`
  const codeLike = all.filter(task => CODE_FILE.test(task))
  if (!codeLike.length) return 'no task names an application source or test file; the plan must implement the behaviour in code (for example src/**/*.ts, tests/**), not describe it in documents'
  // One task carrying most of the spec ("implement createGame, tick, applyInput,
  // getState, gravity, locking, scoring, game over…") is what a small model
  // stubs out and never finishes inside one tool budget. Split it.
  if (requirements.length >= 3) {
    const overloaded = all.filter(task => !/\b(?:test|spec)s?\b/i.test(task.split(/\s+in\s+/)[0] ?? '') && requirements.filter(text => criterionTokens(text).some(token => new RegExp(`\\b${token}\\b`, 'i').test(task))).length > 2)
    if (overloaded.length) return `these tasks each cover more than two requirements at once and will be stubbed rather than finished: ${overloaded.map(task => JSON.stringify(task.slice(0, 100))).join('; ')}. Split them so each task implements one or two requirements with its tests.`
  }
  return undefined
}
/** Test seam for the task normaliser. */
export function normalizeTasksForTest(raw: Record<string, unknown>, repositories: string[] = []): Tasks { return normalizeTasks(raw, repositories) }
function normalizeTasks(raw: Record<string, unknown>, repositories: string[], strictQuestion = true): Tasks {
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).flatMap(item => {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
    const tasks = strings(entry?.tasks, MAX_TASKS, 400).map(task => task.replace(/^\s*(?:task with concrete files|<[^>]*>)\s*:?\s*/i, '').trim()).filter(Boolean)
    return entry && tasks.length ? [{ title: text(entry.title, 'Implementation').slice(0, 120), tasks }] : []
  })
  let remaining = MAX_TASKS
  const capped = groups.map(group => { const tasks = group.tasks.slice(0, Math.max(0, remaining)); remaining -= tasks.length; return { ...group, tasks } }).filter(group => group.tasks.length)
  const verification = (Array.isArray(raw.verification) ? raw.verification : []).flatMap(item => {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
    return entry && typeof entry.repositoryId === 'string' && repositories.includes(entry.repositoryId) && text(entry.command) && !/[\s]/.test(text(entry.command)) ? [{ repositoryId: entry.repositoryId, command: text(entry.command), args: strings(entry.args, 20, 200) }] : []
  }).slice(0, 10)
  // A real question ends in "?" and is not the prompt's own instruction echoed
  // back — models without reasoning copy example text verbatim.
  const question = text(raw.blockingQuestion).slice(0, 4000)
  const genuine = question.length > 0 && (!strictQuestion || (/\?\s*$/.test(question) && !/omit unless|only the requester can choose|leave .*empty/i.test(question)))
  return { groups: capped, verification, ...(genuine ? { blockingQuestion: question } : {}) }
}

/**
 * The compact architect: a bounded inventory, four tool-less structured steps
 * and host-rendered OpenSpec artifacts written through the official workflow, so
 * the graph's participation and completeness checks pass unchanged.
 */
export async function runCompactArchitect(env: CompactEnv): Promise<AgentResult> {
  const { inputs } = env
  const roots = env.toolset.roots
  await openspecCall(env, { action: 'load_skill' })
  // 1. Inventory: what exists, so every later step reasons from facts.
  const greenfieldByHost = hostGreenfield(roots)
  const inventoryLoop = await toolStep(env, {
    system: 'Inventory the repository for a planning step. Start with list_files on ".", open the manifest and entry files you find, and locate existing tests. Do not read more than you need. Finish with one JSON object: {"greenfield":boolean,"languages":[],"frameworks":[],"keyFiles":[],"tests":[],"notes":"one paragraph"}. greenfield is true only when there is no application source code at all.',
    user: `Repositories:\n${inputs.repositories.map(repo => `- ${repo.id}: ${repo.path}`).join('\n') || roots.map(root => `- ${root}`).join('\n')}\n${greenfieldByHost ? 'The host found no application source files in any repository (only OpenSpec artifacts and repository boilerplate).\n' : ''}${inputs.repositoryMap ? bounded(inputs.repositoryMap, 2500) + '\n' : ''}Requested work (for orientation only):\n${bounded(inputs.scope, 2500)}`,
    tools: ['list_files', 'read_file', 'search_text'], maxToolCalls: 12,
  })
  const inventoryRaw = await finalJson(env, 'inventory', inventoryLoop.messages, inventoryLoop.text, INVENTORY_SCHEMA, value => typeof value.greenfield === 'boolean' ? undefined : '"greenfield" must be a boolean')
  const inventory: Inventory = { greenfield: greenfieldByHost || inventoryRaw.greenfield === true, languages: strings(inventoryRaw.languages, 10, 60), frameworks: strings(inventoryRaw.frameworks, 10, 60), keyFiles: strings(inventoryRaw.keyFiles, 20, 300), tests: strings(inventoryRaw.tests, 20, 300), notes: text(inventoryRaw.notes).slice(0, 1500) }
  // No engineer or shell will ever add media files: a plan that "loads
  // assets" sends the developer chasing .wav/.mp3 it cannot produce
  // (observed: a 4-byte RIFF stub and an unrunnable generator script).
  const assetsNote = hasBinaryAssets(roots) ? '' : 'The repository contains NO binary assets (audio, images, fonts) and none will be added by anyone: the implementer has no shell and cannot download or generate media. Design every audiovisual effect to be produced at runtime by code (Web Audio API oscillators, canvas drawing, CSS) and never condition behaviour on loading asset files.\n'
  const facts = `Repository inventory (facts):\n${JSON.stringify(inventory)}\n${assetsNote}${inventory.greenfield ? 'The repository has no application code; the spec means building it from scratch. This is expected, not an open question.\n' : ''}`
  const scope = `Requested work (frozen scope):\n${bounded(inputs.scope, 6000)}\n${inputs.answers ? `Answers from the requester (authoritative):\n${inputs.answers}\n` : ''}`
  // 2. Proposal.
  const proposalRaw = await structuredStep(env, 'proposal', 'Write the OpenSpec proposal for the requested work. JSON: {"why":"1-2 sentences","whatChanges":["specific change"],"capabilities":{"new":["kebab-case-name"],"modified":["existing-kebab-case-name"]},"impact":["affected code or system"]}. Capabilities are the spec files this change creates; one to three short kebab-case names.', scope + facts, PROPOSAL_SCHEMA, value => text(value.why) ? undefined : '"why" must be a non-empty string')
  const changeName = env.openspec.context.change
  const capabilityNames = {
    new: [...new Set(strings((proposalRaw.capabilities as Record<string, unknown> | undefined)?.new, MAX_CAPABILITIES, 80).map(slug).filter(name => SLUG.test(name)))],
    modified: [...new Set(strings((proposalRaw.capabilities as Record<string, unknown> | undefined)?.modified, MAX_CAPABILITIES, 80).map(slug).filter(name => SLUG.test(name)))],
  }
  capabilityNames.modified = capabilityNames.modified.filter(name => !capabilityNames.new.includes(name))
  if (!capabilityNames.new.length && !capabilityNames.modified.length) capabilityNames.new = [changeName]
  const proposal: Proposal = { why: text(proposalRaw.why), whatChanges: strings(proposalRaw.whatChanges, 20, 400), capabilities: capabilityNames, impact: strings(proposalRaw.impact, 20, 400) }
  // 3. Design.
  const designRaw = await structuredStep(env, 'design', 'Write the OpenSpec design for the proposal. JSON: {"context":"current state and constraints","goals":[],"nonGoals":[],"decisions":[{"title":"","choice":"","why":""}],"risks":[{"risk":"","mitigation":""}]}. Name the concrete files or modules to create or change; keep decisions to the ones that matter.', scope + facts + `Proposal:\n${JSON.stringify(proposal)}\n`, DESIGN_SCHEMA, value => text(value.context) ? undefined : '"context" must be a non-empty string')
  const design: Design = { context: text(designRaw.context), goals: strings(designRaw.goals, 12, 400), nonGoals: strings(designRaw.nonGoals, 12, 400),
    decisions: (Array.isArray(designRaw.decisions) ? designRaw.decisions : []).flatMap(item => { const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined; return entry && text(entry.title) && text(entry.choice) ? [{ title: text(entry.title).slice(0, 120), choice: text(entry.choice).slice(0, 600), why: text(entry.why, 'fits the requested scope').slice(0, 600) }] : [] }).slice(0, 10),
    risks: (Array.isArray(designRaw.risks) ? designRaw.risks : []).flatMap(item => { const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined; return entry && text(entry.risk) ? [{ risk: text(entry.risk).slice(0, 300), mitigation: text(entry.mitigation, 'covered by the verification commands').slice(0, 400) }] : [] }).slice(0, 10) }
  // 4. Specs, one call per capability.
  const specs: Spec[] = []
  for (const name of [...capabilityNames.new, ...capabilityNames.modified]) {
    // The requester's frozen acceptance criteria are the source of truth: each
    // one becomes a requirement, so a terse model cannot shrink a rich spec
    // into "two to five" generic requirements that the plan then "covers".
    const frozen = inputs.criteria.map(item => item.requirement)
    const perCapability = Math.max(2, Math.ceil(frozen.length / Math.max(1, capabilityNames.new.length + capabilityNames.modified.length)))
    const already = specs.flatMap(spec => spec.requirements.map(item => `${item.name} (${spec.name})`))
    const raw = await structuredStep(env, 'specs', `Write the requirements of the capability "${name}" as an OpenSpec delta spec.${already.length ? ` Requirements ALREADY written under other capabilities — do NOT restate them here, only what is specific to "${name}": ${already.slice(0, 30).join('; ')}.` : ''} JSON: {"name":"${name}","requirements":[{"name":"short requirement name","text":"The system SHALL …","scenarios":[{"name":"scenario name","when":"condition","then":"observable outcome"}]}]}. Use SHALL or MUST in every requirement text; every requirement needs at least one testable scenario. ${frozen.length ? `Turn EACH of the requester's acceptance criteria that belongs to this capability into its own requirement (${perCapability} or more here; every criterion must end up in exactly one capability) — keep their exact obligations (names, API signatures, numbers), never merge or paraphrase them away.` : 'Two to five requirements.'}`, scope + `${frozen.length ? `Requester's acceptance criteria (authoritative):\n${frozen.map((item, n) => `${n + 1}. ${item}`).join('\n')}\n` : ''}Proposal:\n${JSON.stringify(proposal)}\nDesign decisions:\n${JSON.stringify(design.decisions)}\n`, SPEC_SCHEMA, value => normalizeSpec(value, name).requirements.length ? undefined : 'at least one requirement with name and text is required', { ...PLANNING_CONTROLS, reasoningEffort: 'medium' })
    specs.push(normalizeSpec(raw, name))
  }
  {
    const deduped = dedupeSpecRequirements(specs)
    if (deduped.dropped.length) env.onEvent?.({ kind: 'text', text: `Compact architect: dropped ${deduped.dropped.length} requirement${deduped.dropped.length === 1 ? '' : 's'} restated across capabilities (${deduped.dropped.slice(0, 4).map(item => `"${item.requirement}" in ${item.capability} ≈ ${item.keptIn}`).join('; ')}${deduped.dropped.length > 4 ? '; …' : ''}).` })
    const covered = coverCriteria(deduped.specs, inputs.criteria.map(item => item.requirement))
    if (covered.added.length) env.onEvent?.({ kind: 'text', text: `Compact architect: ${covered.added.length} acceptance criteri${covered.added.length === 1 ? 'on was' : 'a were'} missing from every spec and ${covered.added.length === 1 ? 'was' : 'were'} appended verbatim (${covered.added.map(item => `"${item.slice(0, 60)}"`).join('; ')}).` })
    specs.splice(0, specs.length, ...covered.specs)
    for (const key of ['new', 'modified'] as const) capabilityNames[key] = capabilityNames[key].filter(name => specs.some(spec => spec.name === name))
  }
  // 5. Tasks and proposed verification.
  // The five-group skeleton exists for a GREENFIELD repository. Handed to a
  // small model for a repository that already has its manifest, runner and
  // modules, it produced a literal "Scaffold" group with duplicate smoke-test
  // tasks and placeholder files (`src/index.ts`, `src/feature.ts` in a
  // vanilla-JS game — observed twice with the same 32k coder). Brownfield
  // plans are grouped by the requirements and extend the existing modules.
  const skeleton = inventory.greenfield
    ? `following this skeleton — 1. Scaffold (manifest with a \"test\" script, runner config, smoke test) · 2. Domain model (types, data tables) · 3. Core logic (the behaviours the requirements describe) · 4. Integration / public API · 5. Remaining tests — 1 to 3 tasks per group, dropping a group only when the repository already has it.`
    : `grouped by the requirements they implement (for example one group per capability, or logic · integration · remaining tests). The repository ALREADY EXISTS: do not add a \"Scaffold\" group, a smoke test, a manifest or runner task, and never a placeholder or stub file — every task extends the existing modules the inventory lists (${inventory.keyFiles.slice(0, 6).join(', ') || 'see the inventory'}) in the repository's language, or adds a real test to the existing test files. Two tasks must never describe the same work.`
  const tasksRaw = await structuredStep(env, 'tasks', `Break the implementation into ${MIN_TASKS} to ${MAX_TASKS} ordered tasks in 2 to 5 groups ${skeleton} EVERY group's tasks include the tests for the behaviours they implement (tests are written alongside the code, never deferred); group 5 exists ONLY for requirements that no earlier task tests yet, and is omitted when every requirement is already covered. Each task is ONE sentence of work that names the behaviour it implements, the files it creates or changes and the tests it adds (never a bare file name); never add tasks like \"run the tests\", \"verify\", \"commit\" or \"open a PR\". Every requirement listed below MUST be covered by at least one task. Tasks create or change APPLICATION source and test files (for example src/, lib/, tests/) that make the requested behaviour actually run; writing documents, specs, JSON/YAML descriptions or plans is NOT an implementation task, and the OpenSpec artifacts under openspec/ are frozen planning documents that MUST NOT appear as task targets. JSON: {"groups":[{"title":"<area name>","tasks":["<one sentence: what behaviour, in which files, with which tests>"]}],"verification":[{"repositoryId":"<id>","command":"npm","args":["test"]}],"blockingQuestion":""}. Leave "blockingQuestion" EMPTY unless several plausible designs exist and only the requester can choose; if you ask, write the actual question ending in "?". "verification" lists one existing (or task-added) automated command per repository that has no host-configured check; omit it when none applies.`, scope + facts + `Proposal:\n${JSON.stringify(proposal)}\nDesign:\n${JSON.stringify(design)}\nRequirements (each MUST map to a task):\n${specs.flatMap(spec => spec.requirements.map(item => `- [${spec.name}] ${item.name}: ${item.text.slice(0, 160)}`)).join('\n')}${inputs.criteria.length ? `\nRequester's acceptance criteria (authoritative — every one needs a task that implements and tests it):\n${inputs.criteria.map((item, n) => `${n + 1}. ${item.requirement.slice(0, 200)}`).join('\n')}` : ''}\n${inputs.configuredVerification ? inputs.configuredVerification + '\n' : ''}Repository ids: ${inputs.repositories.map(repo => repo.id).join(', ') || '(single repository)'}${on(env, 'plan-language-hint') ? languageLine(env.toolset.roots) : ''}`, TASKS_SCHEMA, value => on(env, 'plan-validation') ? validateTaskPlan(value, inputs.repositories.map(repo => repo.id), inputs.criteria.length ? inputs.criteria.map(item => item.requirement) : specs.flatMap(spec => spec.requirements.map(item => item.name))) : undefined)
  const tasks = normalizeTasks(tasksRaw, inputs.repositories.map(repo => repo.id), on(env, 'genuine-blocking-question'))
  // 6. The host writes the artifacts through the official workflow, in dependency order.
  await openspecCall(env, { action: 'new' })
  const status = await openspecCall(env, { action: 'status' }) as OpenSpecStatus
  const existingSpecs = new Set(Object.values(status.artifactPaths.specs?.existingOutputPaths ?? []).map(file => path.basename(path.dirname(file))))
  await openspecCall(env, { action: 'instructions', artifact: 'proposal' })
  await openspecCall(env, { action: 'write_artifact', path: 'proposal.md', content: renderProposal(proposal, capabilityNames) })
  await openspecCall(env, { action: 'instructions', artifact: 'design' })
  await openspecCall(env, { action: 'write_artifact', path: 'design.md', content: renderDesign(design, inventory.greenfield) })
  await openspecCall(env, { action: 'instructions', artifact: 'specs' })
  for (const spec of specs) await openspecCall(env, { action: 'write_artifact', path: `specs/${spec.name}/spec.md`, content: renderSpec(spec) })
  for (const stale of existingSpecs) if (!specs.some(spec => spec.name === stale)) env.onEvent?.({ kind: 'text', text: `Existing spec ${stale} of a previous pass was left in place.` })
  await openspecCall(env, { action: 'instructions', artifact: 'tasks' })
  await openspecCall(env, { action: 'write_artifact', path: 'tasks.md', content: renderTasks(tasks.groups) })
  await openspecCall(env, { action: 'validate' })
  const confidence = tasks.blockingQuestion ? 'low' : inventory.greenfield ? 'high' : 'medium'
  const structured: Record<string, unknown> = { confidence, planningDepth: 'full', planningReason: inventory.greenfield ? 'Greenfield repository: the spec is built from scratch.' : 'Compact planning from a bounded inventory.', referencePatterns: inventory.keyFiles.slice(0, 20), riskFlags: design.risks.map(item => item.risk).slice(0, 20),
    ...(tasks.blockingQuestion ? { question: tasks.blockingQuestion } : {}), ...(tasks.verification.length ? { verification: tasks.verification } : {}) }
  const result = JSON.stringify(structured)
  env.onEvent?.({ kind: 'text', text: `Compact architect: ${specs.length} spec${specs.length === 1 ? '' : 's'}, ${tasks.groups.reduce((total, group) => total + group.tasks.length, 0)} tasks, ${inventoryLoop.toolCalls} inventory tool calls.` })
  return { text: result, usage: env.client.usage, structured }
}
