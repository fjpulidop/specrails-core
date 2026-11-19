/**
 * `machineInstalls: 'ask'` (contract 5.17, capability `machineInstalls`): a missing tool that only a
 * machine-wide install provides (`brew install terraform`, `rustup target add …`) is the person's to
 * approve, never the run's to perform. When a write role's structured blocker or a verification
 * precondition names that install, the node memoizes its settled result and asks the person ONE
 * ordinary `question` interrupt carrying the exact command and two structured options. The host
 * performs the approved install itself, outside the run, and answers `installed`; the node then runs
 * again in the same visit (a role turn with a note that the tool is now there, a verification on a
 * fresh receipt). Any other answer (`declined`, `failed: …`, `refused: …`, free text) keeps the
 * blocker, so the run stops exactly as before with the install as its required action.
 */
import type { EngineAnswer, HumanInterrupt, InterruptOption, JsonObject, JsonValue, PieceExecutionContext, PieceResult } from '../contracts.js'
import { answerEntry, boundedText, historyEntry, json } from './shared.js'

/** Install questions one node visit may ask; the next blocker after that ends the node as before. */
export const MACHINE_INSTALL_ROUNDS = 3
/** The only answer that means the host installed the tool; everything else keeps the blocker. */
export const MACHINE_INSTALL_DONE = 'installed'
/** Answer ordinals of install questions, apart from decision questions (0..). */
const ANSWER_ORDINAL = 100

const INSTALLABLE = new Set(['toolchain', 'setup', 'environment'])

export interface MachineInstallRequest { command: string; tool: string }

/** The machine-wide install a blocker names, when it is one line the host can show verbatim. */
export function machineInstallOf(blocker: unknown): MachineInstallRequest | undefined {
  if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) return undefined
  const raw = blocker as Record<string, unknown>
  if (!INSTALLABLE.has(String(raw.kind)) || typeof raw.install !== 'string') return undefined
  const command = raw.install.trim().replace(/^`+|`+$/g, '').trim()
  if (!command || command.length > 300 || /[\r\n]/.test(command)) return undefined
  const named = typeof raw.tool === 'string' && !/[\r\n]/.test(raw.tool) ? raw.tool.trim().slice(0, 120) : ''
  return { command, tool: named || lastPackage(command) }
}

/** `brew install hashicorp/tap/terraform` → `terraform`: the last word that is not a flag. */
function lastPackage(command: string): string {
  const words = command.split(/\s+/).filter(word => word && !word.startsWith('-'))
  const last = (words[words.length - 1] ?? command).replace(/^["']|["']$/g, '')
  return last.split('/').pop()!.replace(/@[^@]*$/, '') || last
}

export const MACHINE_INSTALL_OPTIONS: readonly InterruptOption[] = [
  { id: 'install', label: 'Install', meaning: 'Specrails runs this exact command once, outside the run, remembers the approval and the run continues by itself.' },
  { id: 'self', label: "I'll do it myself", meaning: 'Nothing is installed; the run stops with the command for you to run.' },
]

export function machineInstallQuestion(context: PieceExecutionContext, request: MachineInstallRequest): HumanInterrupt {
  return {
    kind: 'question', prompt: `This run needs ${request.tool}. Install it with \`${request.command}\`?`,
    nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId,
    options: MACHINE_INSTALL_OPTIONS.map(option => ({ ...option })),
    data: { kind: 'machine-install', command: request.command, tool: request.tool },
  }
}

/** The host's answer: `installed`, or why nothing was installed (`declined`, `failed: …`, `refused: …`, other text). */
export function readInstallAnswer(response: JsonValue): { installed: boolean; answer: string } {
  const answer = typeof response === 'string' ? response : response && typeof response === 'object' && !Array.isArray(response) && typeof response.answer === 'string' ? response.answer : JSON.stringify(response)
  return { installed: answer.trim() === MACHINE_INSTALL_DONE, answer: boundedText(answer.trim(), 2000) }
}

/** What the person decided, as one sentence for the blocker's required action. */
function declinedAction(request: MachineInstallRequest, answer: string): string {
  const detail = /^(?:failed|refused):\s*/i.test(answer) ? answer.replace(/^(?:failed|refused):\s*/i, '') : ''
  if (/^failed:/i.test(answer)) return `The approved install \`${request.command}\` failed${detail ? ` (${detail})` : ''}. Install it yourself, then continue the run.`
  if (/^refused:/i.test(answer)) return `Specrails cannot run \`${request.command}\` for you${detail ? ` (${detail})` : ''}. Run it yourself, then continue the run.`
  return `Run \`${request.command}\` yourself (it is shared by every project on this machine), then continue the run.`
}

/** The same result with the blocker's required action naming the person's step. */
function withPersonAction(result: PieceResult, locate: (output: JsonObject) => JsonObject | undefined, request: MachineInstallRequest, answer: string): PieceResult {
  const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output) ? structuredClone(result.output) as JsonObject : undefined
  const blocker = output ? locate(output) : undefined
  if (!output || !blocker) return result
  blocker.requiredAction = declinedAction(request, answer)
  const message = result.error ? { error: { ...result.error, message: `${typeof blocker.reason === 'string' ? blocker.reason : result.error.message} ${blocker.requiredAction}`.trim() } } : {}
  return { ...result, output, ...message }
}

export interface InstallAsking {
  /** Runs the node once; `installed` names what the host installed before this rerun. */
  run(installed: readonly MachineInstallRequest[]): Promise<PieceResult>
  /** Where the result's blocker lives (a role's `structured.blocker`, a verification's `blocker`). */
  blocker(output: JsonObject): JsonObject | undefined
  memo: { get(key: string): JsonValue | undefined; set(key: string, value: JsonValue): void }
  /** Memo namespace; distinct per caller so nested askers never share a round. */
  key: string
  onInstalled?(request: MachineInstallRequest): void
}

/** Ask for each machine-wide install a node's result names, at most MACHINE_INSTALL_ROUNDS times, rerunning after each one the host performed. */
export async function askMachineInstalls(context: PieceExecutionContext, asking: InstallAsking): Promise<PieceResult> {
  const installed: MachineInstallRequest[] = [], answers: EngineAnswer[] = [], history: string[] = []
  for (let round = 0; ; round += 1) {
    const key = `${asking.key}:${round}`
    const saved = asking.memo.get(key) as unknown as PieceResult | undefined
    const result = saved ?? await asking.run(installed)
    const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output) ? result.output : undefined
    const request = output ? machineInstallOf(asking.blocker(output)) : undefined
    if (!request || round >= MACHINE_INSTALL_ROUNDS) return settle(context, result, answers, history)
    if (!saved) asking.memo.set(key, json(result))
    const response = context.interrupt(machineInstallQuestion(context, request))
    const { installed: done, answer } = readInstallAnswer(response)
    answers.push(answerEntry(context, response, ANSWER_ORDINAL + round))
    history.push(`Machine-wide install requested: ${request.command}\nAnswer: ${answer}`)
    if (!done) return settle(context, withPersonAction(result, asking.blocker, request, answer), answers, history)
    installed.push(request)
    asking.onInstalled?.(request)
  }
}

function settle(context: PieceExecutionContext, result: PieceResult, answers: EngineAnswer[], history: string[]): PieceResult {
  if (!answers.length) return result
  const texts = [...history, ...(result.history ?? []).map(entry => entry.text)]
  return { ...result, answers: [...(result.answers ?? []), ...answers], history: texts.map((entry, ordinal) => historyEntry(context, entry, ordinal)) }
}

/** The task note a role turn reads after the host installed a tool for it. */
export function installedNote(installed: readonly MachineInstallRequest[]): string {
  if (!installed.length) return ''
  return '\n\n## Host install\n' + installed.map(item => `The person approved \`${item.command}\` and the host ran it outside the run: ${item.tool} is now installed on this machine.`).join('\n')
    + '\nContinue the remaining work and rerun the checks that were blocked. Never install anything machine-wide yourself; if something else is still missing, return the structured blocker with its exact install.'
}
