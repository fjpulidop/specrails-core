import { SessionError } from './errors.js'
import type { DriverDescriptor } from './types.js'

const DRIVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const COST = new Set(['session-cumulative', 'per-turn', 'none'])
const TOKENS = new Set(['per-turn', 'cumulative', 'none'])

/**
 * Validate a driver descriptor, including capability coherence: a driver
 * cannot claim behaviour that depends on a capability it does not have.
 */
export function validateDescriptor(descriptor: DriverDescriptor): void {
  const fail = (message: string) => { throw new SessionError('internal', `Invalid driver descriptor "${descriptor?.id}": ${message}`) }
  if (!descriptor || typeof descriptor.id !== 'string' || !DRIVER_ID.test(descriptor.id)) fail('id must match [a-z0-9][a-z0-9._-]{0,63}')
  if (typeof descriptor.displayName !== 'string' || !descriptor.displayName.trim()) fail('displayName is required')
  const caps = descriptor.capabilities
  if (!caps) fail('capabilities are required')
  for (const key of ['resident', 'nativeInputQueue', 'subagentDisable', 'autonomousContinuation', 'steer', 'toolFiltering'] as const) {
    if (typeof caps[key] !== 'boolean') fail(`capabilities.${key} must be a boolean`)
  }
  if (caps.subagents !== 'supported' && caps.subagents !== 'unsupported') fail('capabilities.subagents must be supported|unsupported')
  if (caps.subagents === 'unsupported' && (caps.subagentDisable || caps.autonomousContinuation)) fail('sub-agent capabilities require subagents=supported')
  if (!caps.resident && caps.nativeInputQueue) fail('a native input queue requires a resident process')
  if (!caps.resident && caps.autonomousContinuation) fail('autonomous continuation requires a resident process')
  if (!COST.has(caps.usage?.costUsd) || !TOKENS.has(caps.usage?.tokens)) fail('capabilities.usage is invalid')
}
