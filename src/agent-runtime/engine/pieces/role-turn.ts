import { contentDigest } from '../canonical-json.js'
import { advisoryMemory } from './project-memory.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { withScopeDefault } from '../../change-scope.js'
import { resolveRoleDescriptor } from '../../config.js'
import { AgentExecutionError } from '../../executor-types.js'
import type { VerificationCommand } from '../../../pipeline/pipeline-state.js'
import { createRoleInvoker } from '../../graph/roles.js'
import { admitVerificationProposals } from '../../verification-proposals.js'
import { guardrailEnabled } from '../../guardrails.js'
import { installEnvironment, prepareEnvironment, type InstallOutcome } from '../../compact/environment.js'
import { roleInstructions, type AdoptedOutput, type DerivationReport } from '../../prompts.js'
import { projectRulesContext } from '../../project-rules.js'
import { EngineError, type EngineAnswer, type HistoryEntry, type JsonObject, type JsonValue, type Piece, type PieceExecutionContext, type PieceResult } from '../contracts.js'
import type { PieceDependencies, PieceDependencyProvider } from './ports.js'
import { REVIEWER_MARKED_KINDS, triageReviewIssues, type NonActionableIssue } from './review-triage.js'
import { answerText, structuredQuestion } from '../question-options.js'
import { askMachineInstalls, installedNote } from './machine-install.js'
import { answerEntry, boundedText, historyEntry, idSchema, json, paramsSchema, invocationTimers, stringSchema, text } from './shared.js'

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false, ownProperties: true })

export function roleTurnPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'role-turn', paramsSchema: paramsSchema({ ...invocationTimers, roleId: idSchema, prompt: { ...stringSchema, minLength: 1 }, structuredOutput: { type: 'object' }, sessionContinuity: { enum: ['run', 'none'] }, stance: { enum: ['fixer'] }, verificationProposalsFrom: { type: 'string', minLength: 1, maxLength: 128 }, decisions: { enum: ['ask'] }, machineInstalls: { enum: ['ask'] } }, ['roleId', 'prompt']), outcomes: ['next', 'invalid', 'failed'], effect: 'derived', requiresAI: true, storeAccess: 'write' },
    getOutcomes: params => params.structuredOutput ? ['next', 'invalid', 'failed'] : ['next', 'failed'],
    getEffect: (params, roles) => {
      const role = roles[text(params.roleId)]
      if (!role) throw new EngineError('role_not_found', 'Role is not configured: ' + text(params.roleId))
      return role.access
    },
    execute: async (params, context) => {
      const deps = bindings()
      // A write role whose blocker names a machine-wide install asks the person once (capability machineInstalls).
      const asksInstalls = params.machineInstalls === 'ask' && resolveRoleDescriptor(deps.config, text(params.roleId)).access === 'write'
      const turn: RoleTurn = (turnParams, key) => asksInstalls
        ? askMachineInstalls(context, { key: 'machine-install:' + key, memo: deps.memo(context), blocker: structuredBlocker,
          run: installed => executeRoleTurn(deps, installed.length ? { ...turnParams, prompt: text(turnParams.prompt) + installedNote(installed) } : turnParams, context) })
        : executeRoleTurn(deps, turnParams, context)
      const result = params.decisions === 'ask' ? await executeDecisionTurns(deps, params, context, turn) : await turn(params, 'turn')
      return triageReview(deps, params, context, result)
    },
  }
}

/** Answers one prompt carries (newest win) and their bounded size. */
const PERSON_ANSWERS_MAX = 6
const PERSON_ANSWER_CHARS = 1500

/**
 * The person's answers to this run's earlier questions, for every later role turn. Without them a
 * reviewer judged the change against the frozen ticket text, rejected a developer that followed the
 * person's answer ("I cannot verify that answer outside design.md"), and the fixer asked the person
 * the same question again (bench5 decision-dev). Empty when nobody has answered anything.
 */
export function personAnswersNote(answers: readonly EngineAnswer[], access: 'read' | 'write'): string {
  // `$answers`, not `$history`: the history is bounded to a few KB and an early planner answer is gone by review time.
  const answered = answers.flatMap(entry => entry.asked ? [entry.asked] : []).slice(-PERSON_ANSWERS_MAX)
  if (!answered.length) return ''
  return [
    '', '', "## The person's answers in this run",
    'The person already answered these questions. Each answer is authoritative for this change, even where the ticket or a frozen artifact says otherwise, and settles that question: never ask it again.',
    access === 'read'
      ? 'A criterion an answer changes or withdraws is judged by the answer: it is a material `exception` the person accepted (`acceptedBy: "user"`, `approvalEvidence` quoting the answer), never a reason to reject the change.'
      : 'Follow these answers; where one contradicts a task, the answer wins and your summary says how you applied it.',
    ...answered.map((entry, index) => `${index + 1}. Asked: ${JSON.stringify(boundedText(entry.question, PERSON_ANSWER_CHARS))}\n   The person answered: ${JSON.stringify(boundedText(entry.answer, PERSON_ANSWER_CHARS))}`),
  ].join('\n')
}

/** One role-turn invocation; `key` keeps the memo rounds of nested askers apart. */
type RoleTurn = (params: JsonObject, key: string) => Promise<PieceResult>
function structuredBlocker(output: JsonObject): JsonObject | undefined {
  const structured = output.structured
  const blocker = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured.blocker : undefined
  return blocker && typeof blocker === 'object' && !Array.isArray(blocker) ? blocker : undefined
}

type Review = JsonObject & { approved: boolean; issues: JsonValue[] }
function reviewOf(result: PieceResult): Review | undefined {
  const structured = result.outcome === 'next' ? (result.output as JsonObject | undefined)?.structured : undefined
  return structured && typeof structured === 'object' && !Array.isArray(structured) && typeof structured.approved === 'boolean' && Array.isArray(structured.issues) ? structured as Review : undefined
}
const noteLine = (item: NonActionableIssue): string => `Not a run issue (${item.reason}): ${boundedText(item.text, 1000)}`

/**
 * Review triage (contract 5.17, capability `reviewTriage`): a read role whose structured output has
 * `approved` and `issues` is a review. Issues the developer cannot act on (a host-only check, a
 * regenerated lockfile, a frozen artifact, a criterion the person withdrew) leave `issues` and reach
 * the person as notes (`brief.humanChecks` when the review declares it, and `reviewNotes`), so they
 * neither block delivery nor burn a correction round. A rejection that consisted only of such issues
 * is re-judged once without them; a rejection with any actionable issue stands unchanged.
 */
async function triageReview(deps: PieceDependencies, params: JsonObject, context: PieceExecutionContext, result: PieceResult): Promise<PieceResult> {
  const roleId = text(params.roleId)
  const first = reviewOf(result)
  if (!first || resolveRoleDescriptor(deps.config, roleId).access !== 'read') return result
  const change = deps.openspec?.(context)?.[roleId]?.change
  const answers = context.state.$answers.map(entry => typeof entry.value === 'string' ? entry.value
    : entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value) && typeof entry.value.answer === 'string' ? entry.value.answer : JSON.stringify(entry.value))
  const triage = (review: Review) => triageReviewIssues(review.issues, { ...(change ? { change } : {}), answers })
  let triaged = triage(first)
  if (!triaged.nonActionable.length) return result
  let settled = result, review = first, notes = [...triaged.nonActionable]
  const histories = [...(result.history ?? []).map(entry => entry.text)]
  if (!first.approved && !triaged.actionable.length) {
    histories.push(`Core review triage: every issue of this rejection is one the run cannot act on; they go to the person as notes and the change is re-judged without them:\n${notes.map(item => '- ' + noteLine(item)).join('\n')}`)
    const again = await executeRoleTurn(deps, { ...params, prompt: text(params.prompt) + [
      '', '', '## Core review triage',
      'Your previous review rejected this change only for issues the developer and the fixer cannot act on. Core handed them to the person as notes:',
      ...notes.map(item => '- ' + noteLine(item)),
      'Re-judge the change without them and do not raise them again. Approve when nothing the developer can change inside this change remains; score and aspects judge the code and the tests, never these notes. Raise an issue only for work the run can do itself (code, tests, documentation, a check the host plan already runs).',
    ].join('\n') }, context)
    const second = reviewOf(again)
    if (second) {
      settled = again; review = second; triaged = triage(second)
      notes = [...notes, ...triaged.nonActionable.filter(item => !notes.some(note => note.text === item.text))]
      histories.push(...(again.history ?? []).map(entry => entry.text))
    }
  }
  const lines = notes.map(noteLine)
  const structured: JsonObject = { ...review, issues: triaged.actionable as JsonValue[] }
  const brief = review.brief
  // Advice and out-of-scope findings are notes, not checks the person must make: only the other kinds join humanChecks.
  const checkLines = notes.filter(item => !REVIEWER_MARKED_KINDS.has(item.kind)).map(noteLine)
  if (checkLines.length && brief && typeof brief === 'object' && !Array.isArray(brief) && Array.isArray(brief.humanChecks)) {
    const checks = brief.humanChecks
    structured.brief = { ...brief, humanChecks: [...checks, ...checkLines.filter(line => !checks.includes(line))] }
  }
  if (histories.length === (result.history ?? []).length) histories.push(`Core review triage moved ${notes.length} issue(s) the run cannot act on to the person's notes:\n${lines.map(line => '- ' + line).join('\n')}`)
  return { ...settled, output: { ...(settled.output as JsonObject), structured, reviewNotes: notes.map(item => ({ kind: item.kind, issue: boundedText(item.text, 1000), reason: item.reason })) },
    history: histories.map((entry, ordinal) => historyEntry(context, entry, ordinal)) }
}

/** The structured field a role fills with the one decision only the person can make (`decisions: 'ask'`). */
export const DECISION_FIELD = 'decisionNeeded'
/** questionOptions: the choices the role offers with its decision, and the one it recommends. */
export const DECISION_OPTIONS_FIELD = 'decisionOptions'
export const DECISION_RECOMMENDED_FIELD = 'decisionRecommended'
const DECISION_FIELDS = [DECISION_FIELD, DECISION_OPTIONS_FIELD, DECISION_RECOMMENDED_FIELD]
const decisionOptionSchema = { type: 'object', additionalProperties: false, required: ['id', 'label', 'meaning'], properties: { id: { type: 'string' }, label: { type: 'string' }, meaning: { type: 'string' } } }
/** Questions one role-turn visit may ask before its last round must finish without asking. */
export const DECISION_ROUNDS = 3
const DECISION_RULE = [
  '',
  '',
  '## A decision only the person can make',
  `Use \`${DECISION_FIELD}\` only when you cannot finish because the approved artifacts contradict each other or the ticket (for example a task requires what design.md lists as a non-goal, or two requirements exclude each other) and any choice would be a product decision the person must own. Then do all the work the decision does not affect, leave the affected tasks unticked, and put one concrete question in \`${DECISION_FIELD}\`: what conflicts (quote both sides) in one or two plain sentences. Put the choices in \`${DECISION_OPTIONS_FIELD}\` (two to four, each {id, label, meaning}: a short kebab-case id, a label of at most six words the person clicks, and one sentence on what it means for the change) and the id of the one you recommend in \`${DECISION_RECOMMENDED_FIELD}\`. The run pauses, asks the person and gives you their answer in this same step. Never write such a decision into \`incomplete\`, a blocker or your summary instead (for example "the person must choose" or "conflicts with the non-goal"): those end the run without asking anyone.`,
  `Never use it for anything you can decide, investigate, install or check yourself, for a technical choice the design leaves open (choose and say why in your summary), for a failing test, or for a host blocker (a missing credential, network or variable is the structured blocker). Leave \`${DECISION_FIELD}\` empty in every other case.`,
].join('\n')

/**
 * `decisions: 'ask'` (contract 5.17, capability `roleDecisions`): a role whose work hits a genuine
 * decision (a plan that contradicts itself, conflicting requirements) asks the person through the
 * ordinary `question` interrupt instead of ending the run with unfinished tasks, then reruns in the
 * same node visit with the answer. Each settled round is memoized before its interrupt, so a resume
 * never repeats a provider call; the last round may not ask again. Everything else stays autonomous.
 */
async function executeDecisionTurns(deps: PieceDependencies, params: JsonObject, context: PieceExecutionContext, turn: RoleTurn): Promise<PieceResult> {
  const schema = params.structuredOutput as JsonObject | undefined
  const properties = schema?.properties
  if (!schema || schema.type !== 'object' || !properties || typeof properties !== 'object' || Array.isArray(properties))
    throw new EngineError('invalid_arguments', "decisions: 'ask' requires an object structuredOutput schema with properties")
  for (const field of DECISION_FIELDS) if (field in properties) throw new EngineError('invalid_arguments', `structuredOutput already declares ${field}; decisions: 'ask' adds it`)
  const asking: JsonObject = { ...params, structuredOutput: { ...schema, properties: { ...properties, [DECISION_FIELD]: { type: 'string' },
    [DECISION_OPTIONS_FIELD]: { type: 'array', maxItems: 6, items: decisionOptionSchema }, [DECISION_RECOMMENDED_FIELD]: { type: 'string' } } } }
  const memo = deps.memo(context)
  const answers: EngineAnswer[] = [], history: string[] = [], decisions: JsonObject[] = []
  let answered = ''
  for (let round = 0; ; round += 1) {
    const last = round >= DECISION_ROUNDS
    const key = 'role-decision:' + round
    const saved = memo.get(key) as unknown as PieceResult | undefined
    const result = saved ?? await turn(last ? { ...params, prompt: text(params.prompt) + answered }
      : { ...asking, prompt: text(params.prompt) + DECISION_RULE + answered }, 'decision-' + round)
    const structured = result.outcome === 'next' ? (result.output as JsonObject | undefined)?.structured : undefined
    const record = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : undefined
    const question = !last && typeof record?.[DECISION_FIELD] === 'string' ? record[DECISION_FIELD].trim() : ''
    if (!question) return settleDecisions(context, result, record, answers, history, decisions)
    if (!saved) memo.set(key, json(result))
    for (const entry of result.history ?? []) history.push(entry.text)
    // questionOptions: the choices travel with the question; `prompt` still reads on its own.
    const asked = structuredQuestion({ text: boundedText(question, 4000), asker: params.stance === 'fixer' ? 'fixer' : text(params.roleId), options: record?.[DECISION_OPTIONS_FIELD], recommended: record?.[DECISION_RECOMMENDED_FIELD] })
    const request = { kind: 'question' as const, ...asked, prompt: boundedText(asked.prompt, 6000), nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId }
    const response = context.interrupt(request)
    const answer = boundedText(answerText(response, json(request)), 4000)
    answers.push(answerEntry(context, response, round, { question: boundedText(question, 4000), answer }))
    decisions.push({ question: boundedText(question, 4000), answer })
    history.push(`Human decision requested: ${question}\nHuman answer:\n${answer}`)
    answered += `\n\n## The person's decision ${round + 1}\nYou asked: ${JSON.stringify(boundedText(question, 4000))}\nThe person answered: ${JSON.stringify(answer)}\nThis answer is authoritative for this change and settles that conflict, even where a frozen artifact says otherwise: continue the remaining work accordingly (the artifacts stay as they are; only tick tasks) and say in your summary how you applied it.`
  }
}

function settleDecisions(context: PieceExecutionContext, result: PieceResult, structured: JsonObject | undefined, answers: EngineAnswer[], history: string[], decisions: JsonObject[]): PieceResult {
  if (structured && DECISION_FIELDS.some(field => field in structured)) {
    // The host's schema never declared the fields: the committed output keeps exactly its shape.
    const rest = Object.fromEntries(Object.entries(structured).filter(([key]) => !DECISION_FIELDS.includes(key)))
    result = { ...result, output: { ...(result.output as JsonObject), structured: rest } }
  }
  if (!decisions.length) return result
  const entries: HistoryEntry[] = [...history, ...(result.history ?? []).map(entry => entry.text)].map((entry, ordinal) => historyEntry(context, entry, ordinal))
  return { ...result, ...(result.output && typeof result.output === 'object' && !Array.isArray(result.output) ? { output: { ...result.output, decisions } } : {}), answers: [...answers, ...(result.answers ?? [])], history: entries }
}

/** One invocation path for configured roles, including routing and exactly one repair. */
export async function executeRoleTurn(deps: PieceDependencies, params: JsonObject, context: PieceExecutionContext, options: {
  normalizeStructuredOutput?: (output: Record<string, unknown> | undefined, text: string) => Record<string, unknown> | undefined
  /** Set on the single rerun after the host repaired an environment blocker the agent reported. */
  environmentRetry?: { installs: InstallOutcome[] }
} = {}): Promise<PieceResult> {
  const roleId = text(params.roleId), descriptor = resolveRoleDescriptor(deps.config, roleId)
  // `stance: 'fixer'` makes the turn a correction round: only a write role can
  // correct code. The built-in developer takes the FIXER instructions (and the
  // fixer engine when one is configured); a custom role only labels its events.
  const stance = params.stance === 'fixer' ? 'fixer' as const : undefined
  if (stance && descriptor.access !== 'write') throw new EngineError('invalid_arguments', `The fixer stance requires a role with write access; ${roleId} is ${descriptor.access}`)
  const fixerEngine = stance && roleId === 'developer' ? deps.config.fixer : undefined
  // Agents run sandboxed and cannot install what the repository needs (Codex
  // cannot even write the Playwright browser cache): the host prepares it
  // before any writer turn and says so in the task.
  const hostRepairs = descriptor.access === 'write' && guardrailEnabled(deps.config.guardrails, 'environment-repair')
  const note = (line: string): void => context.progress({ type: 'verification-output', payload: { text: line } })
  const environment = options.environmentRetry
    ? environmentNote(options.environmentRetry.installs, 'retry')
    : hostRepairs ? environmentNote(await prepareEnvironment(deps.context.repositories.map(repository => repository.path), environmentIo(deps, note)), 'prepared') : ''
  const schema = params.structuredOutput as JsonObject | undefined
  const validate = schema ? ajv.compile(schema) : undefined
  const roleState = deps.roleState(context)
  // Sessions never carry across engines: a turn on the fixer engine always starts fresh.
  const previous = params.sessionContinuity !== 'none' && !fixerEngine ? roleState.read().sessions[roleId]?.sessionId : undefined
  const openspec = deps.openspec?.(context)
  if (descriptor.openspecSkill && !openspec?.[roleId]) throw new EngineError('openspec_binding_required', 'Role requires a scoped OpenSpec binding: ' + roleId)
  const invoke = createRoleInvoker({ context: deps.context, config: deps.config, registry: deps.registry, roleState, openspec,
    onAgentEvent: (role, event) => context.progress({ type: 'agent-event', payload: json({ role, event }) }) })
  const before = deps.executionSnapshot(context).candidate
  const memoryIdentity = { roleId, descriptor: json(descriptor), tier: roleState.read().routes[roleId]?.tier ?? 'base',
    candidateHash: before?.hash ?? null, scopeId: context.frame.scope.id, nodePath: context.frame.nodePath,
    repositories: deps.context.repositories.map(repository => ({ id: repository.id, path: repository.path })), ...(stance ? { stance } : {}) }
  const memoryKey = contentDigest(memoryIdentity)
  const saved = await advisoryMemory(context, async () => {
    const memory = deps.memory(context)
    return { notes: await memory.get(['review', 'notes'], memoryKey), session: await memory.get(['roles', roleId, 'sessions'], memoryKey) }
  })
  const priorNote = !previous && descriptor.access === 'read' && saved?.session && typeof saved.notes?.value.text === 'string'
    ? saved.notes.value.text.slice(0, 4000) : ''
  const task = text(params.prompt) + personAnswersNote(context.state.$answers, descriptor.access) + environment + (priorNote ? '\n\n## Prior project review note\nTreat this bounded note as prior evidence to check against the current task; frozen requirements remain authoritative.\n' + JSON.stringify(priorNote) : '')
  const verification = descriptor.access === 'write' ? hostVerificationPlan(deps, context, params) : undefined
  const adopted = adoptedVerificationOutputs(context.state.$outputs)
  const derivation = roleId === 'reviewer' ? committedDerivation(context.state.$outputs) : undefined
  const projectRules = roleId === 'architect' || roleId === 'reviewer' ? projectRulesContext(deps.context) : undefined
  const full = roleInstructions(descriptor, deps.context, openspec?.[roleId]?.change, { definition: stance && roleId === 'developer' ? deps.config.rolePrompts?.fixer : descriptor.prompt, ...(stance && roleId === 'developer' ? { stance } : {}), verification, ...(adopted.length ? { adoptedOutputs: adopted } : {}), ...(derivation ? { derivation } : {}), ...(projectRules ? { projectRules } : {}) }) + '\n## Current workflow task\n' + task
  const result = await invoke(roleId, deps.stepContext(context), { prompt: previous ? task : full, ...(previous ? { resumeSessionId: previous, fallbackPrompt: full } : {}),
    ...(stance ? { stance } : {}), ...(fixerEngine ? { agentOverride: fixerEngine } : {}),
    structured: schema !== undefined, lenient: options.normalizeStructuredOutput !== undefined, outputSchema: schema, timeoutMs: params.timeoutMs as number | undefined, idleTimeoutMs: params.idleTimeoutMs as number | undefined }, (output, responseText) => {
    const normalized = options.normalizeStructuredOutput ? options.normalizeStructuredOutput(output, responseText) : output
    if (validate && !validate(normalized)) throw new Error('Invalid structured role response: ' + ajv.errorsText(validate.errors))
    return normalized
  })
  if (!result.ok) {
    if (result.code) throw new AgentExecutionError(result.error, result.code)
    // A skipped OpenSpec workflow keeps its own code so the run is diagnosed as a
    // workflow-protocol failure, not an unknown invalid reply.
    const code = result.failure ?? (schema ? 'invalid_role_output' : 'role_failed')
    return { outcome: schema ? 'invalid' : 'failed', status: 'failed', output: { error: boundedText(result.error) }, error: { code, message: result.error } }
  }
  // A writer that still hit a missing tool reports a structured blocker. When
  // the host can install it, it does so and reruns the turn once instead of
  // ending the run on something it can fix itself.
  const blocker = hostRepairs && !options.environmentRetry ? repairableBlocker(result.value) : undefined
  if (blocker) {
    const roots = deps.context.repositories.map(repository => repository.path)
    const io = environmentIo(deps, note)
    const installs = [...await installEnvironment(roots, { ...io, failureOutput: blocker }), ...await prepareEnvironment(roots, io)]
    if (installs.some(install => install.ok)) {
      note('[environment] The agent reported a missing dependency or tool; the host installed it and runs the turn again.')
      return executeRoleTurn(deps, params, context, { ...options, environmentRetry: { installs } })
    }
  }
  const currentState = roleState.read(), session = currentState.sessions[roleId]
  const finalIdentity = { ...memoryIdentity, tier: currentState.routes[roleId]?.tier ?? 'base' }, finalKey = contentDigest(finalIdentity)
  await advisoryMemory(context, async () => {
    const memory = deps.memory(context)
    await memory.put(['roles', roleId, 'sessions'], finalKey, { ...finalIdentity, runId: context.frame.runId,
      ...(session ? { sessionId: session.sessionId, identity: session.identity } : {}), lastAttemptId: context.frame.attemptId })
    if (descriptor.access === 'read') await memory.put(['review', 'notes'], finalKey, { roleId, candidateHash: before?.hash ?? null,
      text: boundedText(result.text, 4000), lastAttemptId: context.frame.attemptId })
  })
  return { outcome: 'next', output: { candidateHash: deps.executionSnapshot(context).candidate?.hash ?? null, text: boundedText(result.text), ...(result.value ? { structured: json(result.value) } : {}) },
    history: [historyEntry(context, result.text)], ...(params.sessionContinuity !== 'none' && !fixerEngine && session ? { session: { sessionId: session.sessionId, identity: session.identity } } : {}) }
}

/** The coverage report a committed `derive-change` output carries (its derivation.json), for the reviewer. */
function committedDerivation(outputs: Record<string, JsonValue | undefined>): DerivationReport | undefined {
  for (const output of Object.values(outputs)) {
    const value = output && typeof output === 'object' && !Array.isArray(output) ? output.derivation : undefined
    if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.unexplainedFiles) && typeof value.files === 'number' && typeof value.explained === 'number')
      return { ...value, unexplainedFiles: value.unexplainedFiles.filter((file): file is string => typeof file === 'string') } as DerivationReport
  }
  return undefined
}

/** Files any committed `verify` output reports as host-adopted verification output (sticky for the run), so no role is told to revert them. */
function adoptedVerificationOutputs(outputs: Record<string, JsonValue | undefined>): AdoptedOutput[] {
  return Object.values(outputs).flatMap(output => {
    const listed = output && typeof output === 'object' && !Array.isArray(output) ? output.adoptedOutputs : undefined
    return Array.isArray(listed) ? listed.flatMap(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.path === 'string'
      ? [{ ...(typeof item.repositoryId === 'string' ? { repositoryId: item.repositoryId } : {}), path: item.path }] : []) : []
  })
}

const REPAIRABLE_BLOCKERS: ReadonlySet<string> = new Set(['toolchain', 'setup', 'environment'])
/** The text of a structured `blocker` the host may be able to install away; undefined for other kinds (credentials, network, scope). */
function repairableBlocker(value: unknown): string | undefined {
  const blocker = (value as { blocker?: unknown } | undefined)?.blocker as Record<string, unknown> | null | undefined
  if (!blocker || typeof blocker !== 'object' || !REPAIRABLE_BLOCKERS.has(String(blocker.kind))) return undefined
  return ['evidence', 'reason', 'command', 'requiredAction'].map(field => typeof blocker[field] === 'string' ? blocker[field] : '').join('\n').slice(0, 8_000)
}
function environmentIo(deps: PieceDependencies, note: (line: string) => void) {
  return { lockfileRepair: guardrailEnabled(deps.config.guardrails, 'lockfile-repair'),
    onEvent: (event: { kind: string; tool?: string; detail?: string; text?: string }) => note(event.kind === 'text' ? event.text ?? '' : `[environment] ${event.tool ?? ''} ${event.detail ?? ''}`.trim()) }
}
/** What the host installed (or could not) for this turn, as task context; empty when nothing was needed. */
function environmentNote(installs: readonly InstallOutcome[], when: 'prepared' | 'retry'): string {
  if (!installs.length) return ''
  const done = installs.filter(install => install.ok).map(install => install.installs ?? `${install.ecosystem} dependencies`)
  const failed = installs.filter(install => !install.ok).map(install => install.detail)
  return '\n\n## Host environment\n' + (when === 'retry' ? 'Your previous turn reported an environment blocker. ' : '')
    + (done.length ? `The host installed ${done.join('; ')} for this workspace${when === 'retry' ? ': continue the remaining work and rerun the checks that were blocked.' : ' before this turn.'} ` : '')
    + (failed.length ? `It could not install: ${failed.join('; ')}. ` : '')
    + 'Do not install these yourself; if something is still missing, return the structured blocker.'
}

/** The complete plan the host will run for the repositories in scope: configured checks plus, when `verificationProposalsFrom`
 * names a committed output, the proposals the verify piece admits (see admitVerificationProposals). */
function hostVerificationPlan(deps: PieceDependencies, context: PieceExecutionContext, params: JsonObject): VerificationCommand[] {
  const inScope = new Set(deps.context.repositories.map(repository => repository.id))
  const commands = deps.config.verification.filter(command => inScope.has(command.repositoryId)).map(command => withScopeDefault(deps.context, command))
  if (typeof params.verificationProposalsFrom === 'string') {
    const source = context.state.$outputs[params.verificationProposalsFrom] as { structured?: { verification?: unknown } } | undefined
    const proposals = (Array.isArray(source?.structured?.verification) ? source.structured.verification.slice(0, 20) : []).filter((proposal): proposal is VerificationCommand => {
      if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false
      const raw = proposal as Partial<VerificationCommand>
      return typeof raw.repositoryId === 'string' && inScope.has(raw.repositoryId) && typeof raw.command === 'string' && Array.isArray(raw.args) && raw.args.every(arg => typeof arg === 'string')
    })
    commands.push(...admitVerificationProposals(deps.context, commands, proposals, raw => withScopeDefault(deps.context, { repositoryId: raw.repositoryId, command: raw.command, args: raw.args, ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) })))
  }
  return commands
}
