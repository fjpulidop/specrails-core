const OFFICIAL_SHORT_MODEL_IDS = new Set(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'])
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/

/**
 * Configurations keep raw provider ids. At the CLI boundary only the managed
 * Kimi aliases gain their documented `kimi-code/` namespace; custom and
 * already-qualified ids stay byte-identical.
 */
export function normalizeKimiCliModel(model: string): string {
  if (!SAFE_MODEL_ID.test(model)) throw new Error('Kimi model id must be 1-128 characters and match [A-Za-z0-9][A-Za-z0-9._/:-]*')
  return OFFICIAL_SHORT_MODEL_IDS.has(model) ? `kimi-code/${model}` : model
}
