import { readFileSync, readdirSync } from 'node:fs'
import { artifactPath } from '../../openspec.js'
import { contentDigest } from '../canonical-json.js'
import { EngineError, type JsonObject, type Piece, type PieceResult } from '../contracts.js'
import type { PieceDependencyProvider } from './ports.js'
import { historyEntry, idSchema, paramsSchema, text } from './shared.js'

/**
 * The `[human]` tag (capability `humanTasks`, contract 5.15) after an optional task number:
 * `- [ ] 4.1 [human] Check the title on a real phone`. Such a task is a check only a person
 * can do; it is never required to be ticked and is reported as a human check instead.
 */
const HUMAN_TAG = /^((?:\d+(?:\.\d+)*\.?\s+)?)\[human\]\s*/i
const TASK_LINE = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm
/** Bounds of the task lists an artifact contract reports. */
const TASK_LIST_LIMIT = 20, TASK_TEXT_LIMIT = 300

/** Every checkbox task of an OpenSpec tasks.md, in order. `human` marks a `[human]` check. */
export function taskCheckboxes(tasks: string): Array<{ done: boolean; text: string; human: boolean }> {
  return [...tasks.matchAll(TASK_LINE)].map(match => {
    const text = match[2].trim()
    return { done: match[1] !== ' ', text, human: HUMAN_TAG.test(text) }
  })
}

/** A `[human]` task's text without its tag ("4.1 Check the title on a real phone"). */
export function humanCheckText(text: string): string {
  return text.replace(HUMAN_TAG, '$1').trim()
}

/**
 * Untagged tasks that ask for a check only a person seems able to do ("a manual check of the
 * running game", "visually verify in a browser"). The run can check UI behaviour itself with
 * commands or the host's browser tool, so such a task must either say how the run checks it
 * or carry the `[human]` tag. A negated mention ("no manual check is needed") is fine.
 */
export function tasksNeedingManualCheck(tasks: ReadonlyArray<{ text: string; human?: boolean }>): string[] {
  const manual = /\b(?:manual(?:ly)?[\s-]+(?:check(?:ed|s|ing)?|review(?:ed|s|ing)?|test(?:ed|s|ing)?|verif(?:y|ied|ication)|qa|inspect(?:ion|ed)?|pass|walk-?through|smoke[\s-]test)|(?:check|verify|test|review|inspect|confirm|validate)(?:s|ed|ing)?\b[^.;\n]{0,60}?\bmanually|by hand|eyeball(?:ing|ed)?|visual(?:ly)?[\s-]+(?:check(?:ed)?|review(?:ed)?|inspect(?:ion|ed)?|verif(?:y|ied|ication)|confirm(?:ed)?)(?![^.;\n]{0,80}\b(?:screenshot|SPECRAILS_BROWSE|playwright|headless)))/i
  const negated = /(?:\b(?:not|never|no|nor|without|avoid|avoiding)|n't)\s+(?:\S+\s+){0,3}$/i
  return tasks.filter(task => !task.human && [...task.text.matchAll(new RegExp(manual.source, 'gi'))]
    .some(match => !negated.test(task.text.slice(Math.max(0, match.index - 40), match.index)))).map(task => task.text)
}

const bounded = (texts: string[]): string[] => texts.slice(0, TASK_LIST_LIMIT).map(text => text.slice(0, TASK_TEXT_LIMIT))

/**
 * Tasks that ask the implementer to edit an artifact that freezes before implementation:
 * the change's proposal.md, design.md or delta specs. Only checkboxes may change after the
 * freeze, so such a task can never be completed. Citing them is fine ("as described in
 * design.md", "do not modify design.md"); the artifact must be the object of an editing
 * verb that is not negated, or the target of recording/writing evidence.
 */
export function tasksEditingFrozenArtifacts(tasks: ReadonlyArray<{ text: string }>, change: string): string[] {
  const escaped = change.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const artifact = '[`\'"]?(?:openspec/changes/' + escaped + '/(?:proposal\\.md|design\\.md|specs/)|(?:proposal|design)\\.md\\b)'
  const edit = new RegExp('\\b(?:modify|modifies|update|updates|edit|edits|amend|amends|change|changes|rewrite|rewrites|fill in|fills in|append to|appends to|add to|adds to|write to|writes to)\\b(?:\\s+\\S+){0,3}?\\s+' + artifact, 'i')
  const record = new RegExp('\\b(?:record|records|write|writes|append|appends|log|logs|document|documents)\\b[^.;\\n]{0,80}?\\b(?:in|into|to)\\s+(?:the\\s+)?' + artifact, 'i')
  // "Do not modify design.md" is the opposite instruction: skip a verb negated just before it.
  const negated = /(?:\b(?:not|never|no|nor|without|avoid|avoiding)|n't)\s+(?:\S+\s+){0,2}$/i
  // Only the current clause can negate the verb ("Do not touch tests. Update design.md" asks for an edit).
  const clause = (before: string): string => before.split(/[.;!?:]\s/).pop() ?? before
  const asks = (pattern: RegExp, task: string): boolean => [...task.matchAll(new RegExp(pattern.source, 'gi'))]
    .some(match => !negated.test(clause(task.slice(Math.max(0, match.index - 40), match.index))))
  return tasks.filter(task => asks(edit, task.text) || asks(record, task.text)).map(task => task.text)
}

/** The bullet lines of every `Non-Goals` / `Out of scope` section of a Markdown artifact, in order. */
export function declaredNonGoals(markdown: string): string[] {
  const goals: string[] = []
  let level = 0
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      if (/^(?:non[\s-]?goals?|out[\s-]of[\s-]scope)\b/i.test(heading[2].replace(/[*_`]/g, '').trim())) level = heading[1].length
      else if (level && heading[1].length <= level) level = 0
      continue
    }
    const bullet = level ? /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line) : null
    if (bullet) goals.push(bullet[1].trim())
  }
  return goals
}

const FILLER = new Set(['the', 'and', 'for', 'with', 'any', 'all', 'this', 'that', 'these', 'those', 'its', 'our', 'into', 'from', 'than', 'via', 'per', 'other', 'more', 'new', 'change', 'changes', 'feature', 'features', 'support', 'supports', 'supporting', 'add', 'adds', 'adding', 'implement', 'implementing', 'implementation', 'provide', 'providing', 'handle', 'handling', 'will', 'won', 'not', 'never', 'yet', 'now', 'only', 'also', 'here', 'there', 'scope', 'goal', 'goals', 'ticket', 'task', 'tasks', 'work', 'make', 'making', 'use', 'using', 'out', 'beyond', 'part', 'does', 'doesn', 'don', 'should', 'must', 'can', 'are', 'was', 'were', 'has', 'have', 'been', 'being', 'such', 'like', 'etc', 'e.g'])
const stem = (word: string): string => word.length > 5 && word.endsWith('ing') ? word.slice(0, -3) : word.length > 4 && word.endsWith('ed') ? word.slice(0, -2)
  : word.length > 4 && word.endsWith('es') && !word.endsWith('ses') ? word.slice(0, -2) : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
const words = (text: string): string[] => (text.toLowerCase().replace(/[`*_]/g, '').replace(/’/g, "'").match(/[a-z0-9][a-z0-9+#.'-]*[a-z0-9+#]|[a-z0-9]/g) ?? []).map(word => word.replace(/\.+$/, ''))
/** The subject of a non-goal bullet ("Touch controls on mobile: keyboard only" → touch, control, mobile): the words before its explanation. */
const nonGoalSubject = (goal: string): string[] => [...new Set(words(goal.split(/:|\s[—–-]\s|\(|;|\.\s/)[0] ?? '').filter(word => word.length >= 3 && !FILLER.has(word)).map(stem))]

/**
 * Tasks that seem to require what the design declares a non-goal (a self-contradicting plan): the
 * developer could only stop and ask. A match needs every word of a short non-goal subject (two of
 * three, or all but one of four or five) in the task, outside a negated clause ("without touch
 * controls") and in a task that does not itself cite the non-goals. Deliberately conservative:
 * the freeze raises it once per plan, and an architect who keeps the plan after reviewing it passes.
 */
/**
 * A non-goal that protects existing code instead of excluding a feature ("No change to `total(items)`",
 * "`total` … Not changed here", "Changing the public API"): only a task that alters its subject
 * contradicts it. A task that merely names it (as an anchor, a style or an untouched neighbour) agrees.
 */
export function protectsExistingCode(goal: string): boolean {
  const plain = goal.replace(/[`*_]/g, '').trim()
  const alteration = '(?:chang|modif|edit|renam|alter|rewrit|refactor|remov|delet|replac|break|rework)'
  return new RegExp(`^(?:no|not|never|nothing|without|(?:does|do|will|must|should)\\s*(?:not|n't)|don't|doesn't|won't)\\b[^.;]{0,40}?\\b${alteration}`, 'i').test(plain)
    || new RegExp(`^${alteration}\\w*ing\\b`, 'i').test(plain)
    || /\b(?:not|never)\s+(?:be(?:ing)?\s+)?(?:changed|modified|edited|touched|renamed|altered|rewritten|refactored|removed|deleted|replaced)\b|\b(?:unchanged|untouched|unmodified)\b|\b(?:stays?|remains?|kept)\s+(?:as[- ]is|the same|unchanged|intact)\b/i.test(plain)
}
/** A clause that alters (not merely names) what it mentions. */
const ALTERS = /\b(?:chang|modif|edit|rewrit|renam|alter|refactor|remov|delet|replac|updat|rework|restructur|extend|break|convert|migrat|drop|deprecat|overrid)\w*/i

export function tasksContradictingNonGoals(tasks: ReadonlyArray<{ text: string; human?: boolean }>, nonGoals: readonly string[]): Array<{ task: string; nonGoal: string }> {
  const negated = /(?:\b(?:no|not|never|nor|without|avoid|avoiding|exclud(?:e|es|ing)|except|instead of)|n't)\s+(?:\S+\s+){0,4}$/i
  const preserved = /\b(?:unchanged|untouched|intact|unmodified|preserv(?:e|es|ed|ing)|(?:is|are|stays?|remains?) (?:kept|the same|as (?:it is|they are|is))|as-is)\b/i
  const found: Array<{ task: string; nonGoal: string }> = []
  for (const goal of nonGoals) {
    const subject = nonGoalSubject(goal)
    if (!subject.length || subject.length > 5 || (subject.length === 1 && subject[0].length < 5)) continue
    const protects = protectsExistingCode(goal)
    for (const task of tasks) {
      if (task.human || /non[\s-]?goal|out[\s-]of[\s-]scope/i.test(task.text) || found.some(item => item.task === task.text)) continue
      const clauses = task.text.split(/[.;!?]\s/)
      const hit = clauses.some(clause => {
        const raw = words(clause), tokens = raw.map(stem)
        const matched = subject.filter(word => tokens.includes(word))
        const enough = subject.length <= 2 ? matched.length === subject.length : matched.length >= Math.max(2, subject.length - 1)
        if (!enough) return false
        // A clause that keeps the subject as it is agrees with a "does not change X" non-goal
        // ("done when `mix` and its test are unchanged"); it never requires X.
        if (preserved.test(clause)) return false
        if (protects && !ALTERS.test(clause)) return false
        const first = Math.min(...matched.map(word => tokens.indexOf(word)))
        return !negated.test(raw.slice(0, first).join(' ') + ' ')
      })
      if (hit) found.push({ task: task.text, nonGoal: goal })
    }
  }
  return found
}

/** A reusable artifact invariant, with no agent roles, phase order or successor policy. */
export function artifactContractPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'artifact-contract', paramsSchema: paramsSchema({
      change: { type: 'string', minLength: 1, maxLength: 128 }, contractId: idSchema, action: { enum: ['freeze', 'check'] },
      requireCompletedTasks: { type: 'boolean' },
    }, ['change', 'contractId', 'action']), outcomes: ['pass', 'fail', 'failed'], effect: 'read', requiresAI: false },
    async execute(params, context): Promise<PieceResult> {
      const deps = bindings(), change = text(params.change)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change) || change.length > 64) throw new EngineError('invalid_arguments', 'Invalid change identifier')
      const store = deps.artifactContracts?.(context)
      if (!store) throw new EngineError('artifact_contract_unavailable', 'Scoped artifact contracts are not bound')
      const directory = 'openspec/changes/' + change
      const files: Record<string, string> = {}
      let bytes = 0
      const read = (relative: string): string => {
        const source = readFileSync(artifactPath(deps.context.artifactRoot, directory + '/' + relative), 'utf8')
        bytes += Buffer.byteLength(source)
        if (bytes > 2 * 1024 * 1024 || Object.keys(files).length >= 200) throw new EngineError('output_limit', 'Artifact contract exceeds its read limit')
        return source
      }
      try {
        for (const name of ['proposal.md', 'design.md', 'tasks.md']) files[name] = read(name)
        const walk = (relative: string): void => {
          for (const entry of readdirSync(artifactPath(deps.context.artifactRoot, directory + '/' + relative), { withFileTypes: true })) {
            const child = relative + '/' + entry.name
            if (entry.isSymbolicLink()) throw new EngineError('artifact_scope_mismatch', 'Artifact contracts reject symlinks')
            if (entry.isDirectory()) walk(child)
            else if (entry.isFile() && entry.name.endsWith('.md')) files[child] = read(child)
          }
        }
        walk('specs')
      } catch (error) {
        if (error instanceof EngineError) throw error
        return { outcome: 'fail', output: { reason: 'required_artifacts_missing' } }
      }
      if (!Object.keys(files).some(name => name.startsWith('specs/')) || Object.values(files).some(source => !source.trim())) return { outcome: 'fail', output: { reason: 'empty_artifacts' } }
      const tasks = taskCheckboxes(files['tasks.md'])
      if (!tasks.length) return { outcome: 'fail', output: { reason: 'tasks_missing' } }
      if (params.action === 'freeze') {
        const frozenEdits = tasksEditingFrozenArtifacts(tasks, change)
        if (frozenEdits.length) return { outcome: 'fail', output: { reason: 'tasks_edit_frozen_artifacts', tasks: frozenEdits.slice(0, 20) },
          history: [historyEntry(context, [`The plan for change ${change} cannot freeze: these tasks edit proposal.md, design.md or the change's delta specs, which freeze before implementation (the implementer may only tick tasks):`,
            ...frozenEdits.slice(0, 20).map(task => '- ' + task.slice(0, 300)),
            'Rewrite each as work on repository files. Do not ask anyone to record evidence in frozen artifacts: host verification and the review keep the evidence.'].join('\n'))] }
        // A plan whose task requires a declared non-goal stops the developer at a decision only the
        // person could make. Raised once per contract: a plan the architect keeps after review freezes.
        const reviewedKey = text(params.contractId) + ':non-goals-reviewed'
        const contradictions = store.get(reviewedKey) === true ? [] : tasksContradictingNonGoals(tasks, [...declaredNonGoals(files['design.md']), ...declaredNonGoals(files['proposal.md'])]).slice(0, TASK_LIST_LIMIT)
        if (contradictions.length) {
          store.set(reviewedKey, true)
          return { outcome: 'fail', output: { reason: 'tasks_contradict_non_goals', tasks: bounded(contradictions.map(item => item.task)), nonGoals: bounded([...new Set(contradictions.map(item => item.nonGoal))]) },
            history: [historyEntry(context, [`The plan for change ${change} contradicts itself: these tasks seem to require what proposal.md or design.md declares a non-goal, so the developer could only stop and ask:`,
              ...contradictions.map(item => `- task ${JSON.stringify(item.task.slice(0, TASK_TEXT_LIMIT))} vs non-goal ${JSON.stringify(item.nonGoal.slice(0, TASK_TEXT_LIMIT))}`),
              'Resolve each before the plan freezes: when the ticket needs it, take it out of the non-goals; when it is out of scope, drop or rewrite the task; when the ticket itself asks for both, return confidence low with one question for the person. Core raises this once: if the overlap is only apparent, keep the plan as it is and it freezes.'].join('\n'))] }
        }
        const manualChecks = tasksNeedingManualCheck(tasks)
        if (manualChecks.length) return { outcome: 'fail', output: { reason: 'tasks_need_manual_check', tasks: bounded(manualChecks) },
          history: [historyEntry(context, [`The plan for change ${change} cannot freeze: these tasks ask for a manual or visual check without saying how the run performs it:`,
            ...bounded(manualChecks).map(task => '- ' + task),
            'The implementer can run commands and, when the host provides it, the browser tool ($SPECRAILS_BROWSE: screenshots, console errors and page text at chosen viewports). Rewrite each task so the run checks it itself (for example with an automated test or a browser-tool screenshot it reads), or, only when a person must judge it (taste, a real device, real credentials), mark it `- [ ] N.M [human] <the check>`: a [human] task is never required to be ticked and reaches the reviewer as a human check.'].join('\n'))] }
      }
      // Completion may change checkboxes, never the approved task descriptions. The [human] tag
      // may be added later: a task the run cannot check becomes a visible human check, never a gap.
      files['tasks.md'] = files['tasks.md'].replace(/^(\s*[-*]\s+\[)[ xX](\]\s+)/gm, '$1 $2')
        .replace(/^(\s*[-*]\s+\[ \]\s+(?:\d+(?:\.\d+)*\.?\s+)?)\[human\]\s*/gim, '$1')
      const fingerprint = contentDigest(files), key = text(params.contractId)
      const perFile: Record<string, string> = Object.fromEntries(Object.keys(files).sort().map(name => [name, contentDigest({ [name]: files[name]! })]))
      if (params.action === 'freeze') store.set(key, { fingerprint, files: perFile })
      else {
        const frozen = store.get(key) as JsonObject | undefined
        if (!frozen) return { outcome: 'fail', output: { reason: 'contract_missing' } }
        if (frozen.fingerprint !== fingerprint) {
          // Say which approved artifact changed: without it the implementer cannot tell why the
          // check keeps failing and the run ends as "tasks still incomplete" after wasted turns.
          const before = frozen.files && typeof frozen.files === 'object' && !Array.isArray(frozen.files) ? frozen.files as Record<string, unknown> : null
          const changed = before ? [...new Set([...Object.keys(before), ...Object.keys(perFile)])].filter(name => before[name] !== perFile[name]).sort() : []
          return { outcome: 'fail', output: { reason: 'artifacts_changed', ...(changed.length ? { changed: bounded(changed) } : {}) },
            history: [historyEntry(context, [`The approved plan of change ${change} was edited after it was frozen${changed.length ? ` (${bounded(changed).join(', ')})` : ''}.`,
              'Only task checkboxes may change. Restore the approved wording exactly (a [human] task keeps its text and stays unticked), then continue the remaining work.'].join('\n'))] }
        }
      }
      // A [human] task is the person's check, never the run's work: it is reported, not required.
      const open = tasks.filter(task => !task.done && !task.human), human = tasks.filter(task => task.human)
      const incomplete = open.length
      const lists = { incompleteTasks: bounded(open.map(task => task.text)), humanChecks: bounded(human.map(task => humanCheckText(task.text))) }
      return { outcome: params.requireCompletedTasks && incomplete ? 'fail' : 'pass', output: { fingerprint, tasks: tasks.length, incomplete, ...lists } }
    },
  }
}
