import type { EngineEffect, JsonObject, WorkflowBudget } from './contracts.js'

export const PIECE_KINDS = ['prompt', 'role-turn', 'decider', 'condition', 'verify', 'shell',
  'openspec-validate', 'openspec-archive', 'approval', 'question', 'gate', 'map', 'join',
  'component', 'implementation', 'end'] as const
export type PieceKind = typeof PIECE_KINDS[number]

export interface DefinitionNode {
  kind: PieceKind
  params: JsonObject
  ends: Record<string, string | null>
  retry?: { maxAttempts?: number; backoffMs?: number; retryOn?: string[] }
  label?: string
}

export interface ComponentBody {
  entry: string
  nodes: Record<string, DefinitionNode>
  maxTransitions?: number
  inputs?: string[]
  outputs?: string[]
}

export interface WorkflowDefinition {
  schemaVersion: 1
  id: string
  version: string
  title: string
  journal: 'ledger-only' | 'implementation'
  change: 'new' | 'existing' | 'none'
  entry: string
  maxTransitions: number
  roles: string[]
  nodes: Record<string, DefinitionNode>
  budget?: WorkflowBudget
  policies?: { failFast?: number; noProgress?: number; historyMaxChars?: number; concurrency?: number }
  components?: Record<string, ComponentBody>
  delivery?: { requiresVerified?: boolean }
}

export type WorkflowDefinitionDraft = Omit<WorkflowDefinition, 'version'> & { version?: string }
export type RoleCatalog = Readonly<Record<string, { access: EngineEffect }>>
export interface DefinitionIssue { code: string; path: string; message: string }
export interface DefinitionGraphNode { id: string; nodePath: string; kind: PieceKind; effect: EngineEffect; outcomes: string[] }
export interface DefinitionGraph {
  id: string
  version: string
  entry: string
  nodes: DefinitionGraphNode[]
  edges: Array<{ from: string; outcome: string; to: string | null }>
}
export type DefinitionValidation =
  | { type: 'runtime-definition-validated'; ok: true; version: string; definition: WorkflowDefinition; graph: DefinitionGraph }
  | { type: 'runtime-definition-validated'; ok: false; errors: DefinitionIssue[] }
