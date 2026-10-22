import { redactSecrets, redactSecretsDeep } from '../../../shared/secret-redaction.js'
import type { SessionEvent, ToolActivity } from './events.js'
import type { SessionSnapshot } from './snapshot.js'

/**
 * Secret redaction at the journal boundary (docs/agent-sessions/journal.md).
 *
 * Only free text and tool I/O are redacted. Identifiers, sequence numbers,
 * phases, usage numbers and host-supplied configuration (`systemPrompt`,
 * `session.updated.changes`, `policy`) are kept as they are: configuration is
 * read back from the snapshot to resume a session, so changing it would change
 * what the provider receives. Event shapes never change: a redacted field keeps
 * its type and an absent field stays absent.
 */
export function redactSessionEvent(event: SessionEvent): SessionEvent {
  switch (event.type) {
    case 'input.accepted':
      return { ...event, text: redactSecrets(event.text) }
    case 'turn.output':
      return { ...event, delta: redactSecrets(event.delta) }
    case 'turn.tool':
      return { ...event, ...redactTool(event) }
    case 'turn.completed':
      return { ...event, text: redactSecrets(event.text), ...(event.error === undefined ? {} : { error: redactSecrets(event.error) }) }
    case 'subagent.started':
      return { ...event, description: redactSecrets(event.description), ...(event.prompt === undefined ? {} : { prompt: redactSecrets(event.prompt) }) }
    case 'subagent.output':
      return {
        ...event,
        ...(event.delta === undefined ? {} : { delta: redactSecrets(event.delta) }),
        ...(event.tool === undefined ? {} : { tool: { ...event.tool, ...redactTool(event.tool) } }),
      }
    case 'subagent.result':
      return { ...event, summary: redactSecrets(event.summary) }
    case 'subagent.phase':
    case 'input.state':
    case 'session.process':
      return event.reason === undefined ? event : { ...event, reason: redactSecrets(event.reason) }
    case 'session.closed':
      return { ...event, reason: redactSecrets(event.reason) }
    case 'provider.diagnostic':
      return { ...event, message: redactSecrets(event.message) }
    default:
      return event
  }
}

function redactTool(tool: ToolActivity): Partial<ToolActivity> {
  return {
    ...(tool.input === undefined ? {} : { input: redactSecretsDeep(tool.input) }),
    ...(tool.output === undefined ? {} : { output: redactSecrets(tool.output) }),
  }
}

/**
 * Redact the free text a snapshot carries (open turn text, sub-agent
 * descriptions, reasons and results). Input fingerprints, configuration and
 * usage are untouched.
 */
export function redactSessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  const subagents: SessionSnapshot['subagents'] = {}
  for (const [id, node] of Object.entries(snapshot.subagents)) {
    subagents[id] = {
      ...node,
      description: redactSecrets(node.description),
      reason: node.reason === null ? null : redactSecrets(node.reason),
      resultSummary: node.resultSummary === null ? null : redactSecrets(node.resultSummary),
    }
  }
  return {
    ...snapshot,
    openTurn: snapshot.openTurn === null ? null : { ...snapshot.openTurn, text: redactSecrets(snapshot.openTurn.text) },
    subagents,
    closedReason: snapshot.closedReason === null ? null : redactSecrets(snapshot.closedReason),
  }
}
