import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'

/** Protocol versions this host speaks (docs/agent-sessions/protocol.md). */
export const SESSION_PROTOCOL_VERSIONS = Object.freeze([1])
/** Longest accepted request line. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024

type Schema = Record<string, unknown>

const id = { type: 'string', minLength: 1, maxLength: 200 }
const text = { type: 'string', maxLength: 1024 * 1024 }
const attachment = { type: 'object', additionalProperties: false, required: ['kind', 'path'], properties: { kind: { enum: ['image', 'file'] }, path: { type: 'string', minLength: 1, maxLength: 4096 }, mimeType: { type: 'string', maxLength: 200 } } }
const mcpServer = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: {
    name: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' },
    command: { type: 'string', maxLength: 4096 },
    args: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 4096 } },
    env: { type: 'object', additionalProperties: { type: 'string', maxLength: 16384 } },
    url: { type: 'string', maxLength: 4096 },
    headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 16384 } },
    autoApprove: { type: 'boolean' },
  },
}
const limits = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(['idleMs', 'stallMs', 'backgroundMaxMs', 'turnInactivityMs', 'maxSettleHandoffs', 'settleDebounceMs'].map((key) => [key, { type: 'integer', minimum: 0 }])),
}
const policy = {
  type: 'object', additionalProperties: false, required: ['subagents'],
  properties: {
    subagents: { enum: ['enabled', 'disabled'] },
    onSubagentsSettled: { enum: ['provider-native', 'resume-agent', 'notify-only'] },
    tools: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { enum: ['default', 'read-only', 'none'] }, allow: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 200 } }, deny: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 200 } } } },
    permissions: { enum: ['bypass', 'workspace-write', 'read-only'] },
    mcp: { type: 'object', additionalProperties: false, properties: { servers: { type: 'array', maxItems: 32, items: mcpServer }, inheritUserScope: { type: 'boolean' } } },
    limits,
  },
}

/** Closed parameter schemas, one per method. */
export const METHOD_SCHEMAS: Readonly<Record<string, Schema>> = Object.freeze({
  'initialize': { type: 'object', additionalProperties: false, required: ['protocolVersions', 'host'], properties: { protocolVersions: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'integer', minimum: 1 } }, host: { type: 'object', additionalProperties: false, required: ['name', 'version'], properties: { name: { type: 'string', maxLength: 200 }, version: { type: 'string', maxLength: 200 } } }, scope: { type: 'string', maxLength: 128 } } },
  'session.open': {
    type: 'object', additionalProperties: false,
    properties: {
      sessionId: id,
      resume: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: id } },
      driver: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
      model: { type: 'string', minLength: 1, maxLength: 200 },
      effort: { type: 'string', maxLength: 50 },
      cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      systemPrompt: text,
      policy,
      providerSessionRef: id,
      metadata: { type: 'object' },
    },
    oneOf: [{ required: ['resume'] }, { required: ['driver', 'model', 'cwd', 'policy'] }],
  },
  'session.send': { type: 'object', additionalProperties: false, required: ['sessionId', 'input'], properties: { sessionId: id, input: { type: 'object', additionalProperties: false, required: ['inputId', 'text', 'delivery'], properties: { inputId: id, text, attachments: { type: 'array', maxItems: 32, items: attachment }, delivery: { enum: ['queue', 'steer'] } } } } },
  'session.interrupt': { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: id } },
  'session.stopSubagents': { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: id, subagentIds: { type: 'array', maxItems: 500, items: id } } },
  'session.update': { type: 'object', additionalProperties: false, required: ['sessionId'], minProperties: 2, properties: { sessionId: id, model: { type: 'string', minLength: 1, maxLength: 200 }, effort: { type: 'string', maxLength: 50 }, systemPrompt: text, policy } },
  'session.close': { type: 'object', additionalProperties: false, required: ['sessionId', 'reason'], properties: { sessionId: id, reason: { type: 'string', minLength: 1, maxLength: 200 } } },
  'session.snapshot': { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: id } },
  'session.events': { type: 'object', additionalProperties: false, required: ['sessionId', 'afterSeq'], properties: { sessionId: id, afterSeq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 5000 } } },
  'session.list': { type: 'object', additionalProperties: false, properties: { state: { enum: ['open', 'closed', 'all'] } } },
  'host.ping': { type: 'object', additionalProperties: false },
  'host.shutdown': { type: 'object', additionalProperties: false, properties: { graceMs: { type: 'integer', minimum: 0, maximum: 120000 } } },
})

export type MethodName = keyof typeof METHOD_SCHEMAS

let validators: Map<string, ValidateFunction> | null = null

/** Compiled validators (lazy, shared). */
export function validatorFor(method: string): ValidateFunction | undefined {
  if (!validators) {
    const ajv = new Ajv2020({ allErrors: false, strict: false, validateFormats: false, ownProperties: true })
    validators = new Map(Object.entries(METHOD_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]))
  }
  return validators.get(method)
}

/** JSON-RPC error codes: standard ones plus one application range for SessionError codes. */
export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_APPLICATION_ERROR = -32000
