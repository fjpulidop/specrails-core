import { StringDecoder } from 'node:string_decoder'
import { executeVerification, executeVerificationCommand, type CommandReceipt, type VerificationCommand, type VerificationReceipt } from '../../../pipeline/pipeline-state.js'
import { assertProposalInScope, withScopeDefault } from '../../change-scope.js'
import type { JsonObject, Piece } from '../contracts.js'
import type { PieceDependencyProvider } from './ports.js'
import { captures, captureSchema, historyEntry, paramsSchema, positiveInteger, stringSchema, text } from './shared.js'
import { receiptEvidence, verificationDeadline } from './verify.js'

const schema: JsonObject = { ...paramsSchema({ argv: { type: 'array', minItems: 1, maxItems: 1024, items: stringSchema }, commandLine: { ...stringSchema, minLength: 1 },
  repositoryId: { type: 'string', minLength: 1, maxLength: 128 }, cwd: { type: 'string', maxLength: 4096 }, env: { type: 'object', additionalProperties: stringSchema },
  timeoutMs: { ...positiveInteger, maximum: 7_200_000 }, captureVars: captureSchema, evidence: { type: 'boolean' }, outputCapBytes: { type: 'integer', minimum: 128, maximum: 1_048_576 },
}, ['repositoryId']), oneOf: [{ properties: { argv: true }, required: ['argv'] }, { properties: { commandLine: true }, required: ['commandLine'] }] }

/** Only explicit commandLine uses a platform shell; structured argv stays structured. */
export function shellCommand(params: JsonObject, platform: NodeJS.Platform = process.platform): VerificationCommand {
  const argv = params.argv as string[] | undefined
  const command = argv ? argv[0] : platform === 'win32' ? process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe' : '/bin/sh'
  const args = argv ? argv.slice(1) : platform === 'win32' ? ['/d', '/s', '/c', text(params.commandLine)] : ['-c', text(params.commandLine)]
  return { repositoryId: text(params.repositoryId), command, args, ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
    ...(params.env ? { env: params.env as Record<string, string> } : {}), timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : 600_000 }
}

export function shellPiece(bindings: PieceDependencyProvider): Piece {
  return { descriptor: { kind: 'shell', paramsSchema: schema, outcomes: ['ok', 'fail', 'failed'], effect: 'write', requiresAI: false },
    async execute(params, context) {
      const deps = bindings()
      const command = withScopeDefault(deps.context, shellCommand(params))
      assertProposalInScope(deps.context, command, 'shell command')
      const log = (output: string): void => context.progress({ type: 'verification-output', payload: { text: output } })
      let receipt: VerificationReceipt | undefined, result: CommandReceipt
      if (params.evidence === true) {
        const port = deps.verification(context)
        let captured: CommandReceipt | undefined
        receipt = await executeVerification(deps.context, { kind: 'scoped', commands: [command] }, {
          ...port, persistCheck: async (check, plan, candidate) => { if (!check.pending) captured = { ...check }; await port.persistCheck(check, plan, candidate) },
        }, log, context.signal, { deadline: verificationDeadline(deps, context) })
        result = captured ?? receipt.commands[0]
      } else result = await executeVerificationCommand(deps.context, command, log, context.signal, { deadline: verificationDeadline(deps, context) })
      const cap = typeof params.outputCapBytes === 'number' ? params.outputCapBytes : 262_144
      const bounded = (value: string): string => new StringDecoder('utf8').write(Buffer.from(value).subarray(0, cap))
      const stdout = bounded(result.stdout ?? ''), stderr = bounded(result.stderr ?? result.output)
      const vars = captures(params, stdout + '\n' + stderr)
      const failed = result.exitCode === -1 || ['timed-out', 'cancelled', 'interrupted'].includes(result.outcome ?? '')
      return { outcome: failed ? 'failed' : result.exitCode === 0 ? 'ok' : 'fail', ...(failed ? { status: 'failed' as const, error: { code: result.outcome === 'timed-out' ? 'timeout' : result.outcome === 'cancelled' ? 'aborted' : 'shell_execution_error', message: result.output } } : {}),
        output: { exitCode: result.exitCode, stdout, stderr, vars, outputTruncated: result.outputTruncated === true || Buffer.byteLength(result.stdout ?? '') > cap || Buffer.byteLength(result.stderr ?? '') > cap },
        vars, history: [historyEntry(context, stdout + (stderr ? '\n' + stderr : ''))], ...(receipt ? { receipt: receiptEvidence(receipt) } : {}) }
    },
  }
}
