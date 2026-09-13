/** Frozen fixture definitions and independent assertions; no model call or install. */
export interface EvaluationCase {
  id: string
  description: string
  repositories: string[]
  source: string
  solution: string
  defects: string[]
  oracle: string
  verification?: string
  correction?: 'verification' | 'review'
}
export const EVALUATION_CORPUS: EvaluationCase[] = [
  { id: 'static-tetris', verification: 'assert.deepStrictEqual(api.clearRows([[1,1]]), [[0,0]])', description: 'Clear complete rows in a static browser game without removing partial rows.', repositories: ['game'], source: 'exports.clearRows = board => board', solution: 'exports.clearRows = board => { const remaining = board.filter(row => row.some(cell => !cell)); return [...Array.from({length: board.length - remaining.length}, () => Array(board[0].length).fill(0)), ...remaining.map(row => [...row])]; }', defects: ['exports.clearRows = board => board', 'exports.clearRows = board => board.filter(row => row.every(Boolean))'], oracle: 'assert.deepStrictEqual(api.clearRows([[1,1],[1,0],[1,1]]), [[0,0],[0,0],[1,0]]); assert.deepStrictEqual(api.clearRows([[0,1],[1,0]]), [[0,1],[1,0]]);' },
  { id: 'local-tested-feature', verification: 'assert.strictEqual(api.subtotal([]), 0)', description: 'Calculate an integer-cent subtotal including repeated quantities and empty baskets.', repositories: ['shop'], source: 'exports.subtotal = items => 0', solution: 'exports.subtotal = items => items.reduce((sum, item) => sum + item.cents * item.quantity, 0)', defects: ['exports.subtotal = items => items.length', 'exports.subtotal = items => items.reduce((sum, item) => sum + item.cents, 0)'], oracle: 'assert.strictEqual(api.subtotal([]), 0); assert.strictEqual(api.subtotal([{cents: 125, quantity: 3}, {cents: 20, quantity: 2}]), 415);' },
  { id: 'cross-repository-contract', verification: 'assert.strictEqual(api.alert().active, true)', description: 'Keep both repositories on the same alert contract: an active severity and its informational flag.', repositories: ['front', 'back'], source: 'exports.alert = () => ({active: false})', solution: 'exports.alert = () => ({active: true, severity: "warning", informational: true})', defects: ['exports.alert = () => ({active: true, severity: "warning"})', 'exports.alert = () => ({active: true, severity: "error", informational: false})'], oracle: 'assert.deepStrictEqual(api.alert(), {active: true, severity: "warning", informational: true});' },
  { id: 'verification-correction', verification: 'assert.strictEqual(api.clamp(11, 0, 10), 10)', description: 'Clamp values to both boundaries, including an already valid value.', repositories: ['math'], source: 'exports.clamp = value => value', solution: 'exports.clamp = (value, min, max) => Math.min(max, Math.max(min, value))', defects: ['exports.clamp = (value, min, max) => Math.max(min, value)', 'exports.clamp = (value, min, max) => Math.min(max, value)'], oracle: 'assert.strictEqual(api.clamp(-1, 0, 10), 0); assert.strictEqual(api.clamp(11, 0, 10), 10); assert.strictEqual(api.clamp(5, 0, 10), 5);', correction: 'verification' },
  { id: 'review-correction', verification: 'assert.strictEqual(typeof api.unique, "function")', description: 'Deduplicate stable values while preserving the first occurrence order.', repositories: ['collections'], source: 'exports.unique = values => values', solution: 'exports.unique = values => [...new Set(values)]', defects: ['exports.unique = values => [...new Set(values)].sort()', 'exports.unique = values => values'], oracle: 'assert.deepStrictEqual(api.unique([3, 1, 3, 2, 1]), [3, 1, 2]); assert.deepStrictEqual(api.unique([]), []);', correction: 'review' },
]
