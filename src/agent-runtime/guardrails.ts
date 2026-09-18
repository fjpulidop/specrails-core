// Configurable guardrails of the small-model (compact) runtime.
//
// Every entry is a process rule the host applies around a local model so a
// 7–30B developer does not derail: a validated plan, frozen planning
// artifacts, one test file per module, evidence before a task is ticked, an
// environment repaired by the host instead of the model, a hanging test
// stopped by silence, a test file the verify command never runs, a runner
// that prints failures but exits 0. All are ON by default; a project may switch one off in
// its runtime configuration (`guardrails: { <id>: false }`) to tune the
// process. Pure bug fixes (candidate fingerprint, correction counter, argument
// repair) are deliberately NOT here: they are correctness, not tuning.
//
// CLI providers never see these: the compact loop is local-engine only.
export const GUARDRAIL_IDS = [
  'plan-validation',
  'genuine-blocking-question',
  'plan-language-hint',
  'frozen-plan-writes',
  'primary-language',
  'duplicate-sibling',
  'one-test-per-module',
  'empty-write',
  'evidence-gated-ticking',
  'inventory-retry',
  'synthetic-corrections',
  'silent-group-closure',
  'verify-per-group',
  'test-reachability',
  'exit-code-honesty',
  'environment-repair',
  'lockfile-repair',
  'verify-idle-timeout',
] as const
export type GuardrailId = (typeof GUARDRAIL_IDS)[number]
export type GuardrailPhase = 'architect' | 'developer' | 'host'
export interface GuardrailDescriptor { id: GuardrailId; phase: GuardrailPhase }
export type GuardrailSettings = Partial<Record<GuardrailId, boolean>>

/** Stable catalog (phase order = pipeline order); labels/descriptions live in the host UI so they can be localized. */
export const GUARDRAIL_CATALOG: readonly GuardrailDescriptor[] = [
  { id: 'plan-validation', phase: 'architect' },
  { id: 'genuine-blocking-question', phase: 'architect' },
  { id: 'plan-language-hint', phase: 'architect' },
  { id: 'frozen-plan-writes', phase: 'developer' },
  { id: 'primary-language', phase: 'developer' },
  { id: 'duplicate-sibling', phase: 'developer' },
  { id: 'one-test-per-module', phase: 'developer' },
  { id: 'empty-write', phase: 'developer' },
  { id: 'evidence-gated-ticking', phase: 'developer' },
  { id: 'inventory-retry', phase: 'developer' },
  { id: 'synthetic-corrections', phase: 'developer' },
  { id: 'silent-group-closure', phase: 'developer' },
  { id: 'verify-per-group', phase: 'developer' },
  { id: 'test-reachability', phase: 'host' },
  { id: 'exit-code-honesty', phase: 'host' },
  { id: 'environment-repair', phase: 'host' },
  { id: 'lockfile-repair', phase: 'host' },
  { id: 'verify-idle-timeout', phase: 'host' },
]

export function isGuardrailId(value: unknown): value is GuardrailId {
  return typeof value === 'string' && (GUARDRAIL_IDS as readonly string[]).includes(value)
}

/** A guardrail is on unless the settings say `false` explicitly. */
export function guardrailEnabled(settings: GuardrailSettings | undefined, id: GuardrailId): boolean {
  return settings?.[id] !== false
}

/** Validates a raw `guardrails` object: only known ids, only booleans. Returns the normalized settings (unset ⇒ omitted). */
export function validateGuardrailSettings(value: unknown, path = 'guardrails'): GuardrailSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected an object`)
  const out: GuardrailSettings = {}
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (!isGuardrailId(key)) throw new Error(`${path}.${key}: unknown guardrail`)
    if (typeof flag !== 'boolean') throw new Error(`${path}.${key}: expected a boolean`)
    out[key] = flag
  }
  return out
}
