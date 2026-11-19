import type { JsonObject, JsonValue } from './contracts.js'

/**
 * Structured questions (capability `questionOptions`, contract 5.17, additive).
 *
 * A `question` interrupt may carry, beside its self-contained `prompt`, the bare
 * question (`text`), who asks (`asker`, a role id), why it matters (`why`), the
 * choices the person picks from (`options`), the one the asker recommends
 * (`recommended`), the choices that end the run (`endsRun`) and an optional
 * `detail` (for example an exact command). A host that ignores them still reads
 * `prompt`, which lists the choices in plain text.
 *
 * The answer is `{ answer, optionId? }`: an `optionId` names one of the offered
 * choices; `answer` is the person's words (the choice's label when they only
 * clicked it). An approval may be rejected with `{ approved: false, reason }`.
 */
export interface QuestionOption { id: string; label: string; meaning?: string; detail?: string }
export interface StructuredQuestion {
  text?: string
  asker?: string
  why?: string
  options?: QuestionOption[]
  recommended?: string
  endsRun?: string[]
  detail?: string
}

export const QUESTION_OPTION_LIMIT = 6
const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

const clip = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, limit) : undefined
}
const slug = (value: string): string => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** Bounded, de-duplicated choices; ids the model left out or malformed are derived from the label. Fewer than two choices is no choice. */
export function boundedOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return []
  const options: QuestionOption[] = []
  for (const [index, item] of value.entries()) {
    if (options.length >= QUESTION_OPTION_LIMIT) break
    const record = typeof item === 'string' ? { label: item } : item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
    const label = clip(record?.label, 80)
    if (!label) continue
    const raw = typeof record?.id === 'string' ? record.id.trim().toLowerCase() : ''
    let id = OPTION_ID.test(raw) ? raw : slug(label) || 'option-' + (index + 1)
    if (!OPTION_ID.test(id)) id = 'option-' + (index + 1)
    if (options.some(option => option.id === id)) id = (id.slice(0, 36) + '-' + (index + 1))
    const meaning = clip(record?.meaning, 300), detail = typeof record?.detail === 'string' && record.detail.trim() ? record.detail.trim().slice(0, 2000) : undefined
    options.push({ id, label, ...(meaning ? { meaning } : {}), ...(detail ? { detail } : {}) })
  }
  return options.length >= 2 ? options : []
}

/** The interrupt fields of a structured question; empty fields are omitted so an unstructured question is unchanged. */
export function structuredQuestion(input: { text: string; asker?: unknown; why?: unknown; options?: unknown; recommended?: unknown; endsRun?: unknown; detail?: unknown }): StructuredQuestion & { prompt: string } {
  const options = boundedOptions(input.options)
  const ids = new Set(options.map(option => option.id))
  const recommended = typeof input.recommended === 'string' ? resolveOptionId(options, input.recommended) : undefined
  const endsRun = Array.isArray(input.endsRun) ? [...new Set(input.endsRun.map(value => typeof value === 'string' ? resolveOptionId(options, value) : undefined).filter((id): id is string => !!id && ids.has(id)))] : []
  const why = clip(input.why, 600), asker = clip(input.asker, 64), detail = typeof input.detail === 'string' && input.detail.trim() ? input.detail.trim().slice(0, 2000) : undefined
  const lines = options.map(option => `- ${option.label}${option.meaning ? `: ${option.meaning}` : ''}${option.id === recommended ? ' (recommended)' : ''}`)
  const prompt = [input.text, ...(why ? ['', why] : []), ...(lines.length ? ['', 'Options:', ...lines] : [])].join('\n')
  return { prompt, ...(options.length || why || asker || detail ? { text: input.text } : {}), ...(asker ? { asker } : {}), ...(why ? { why } : {}),
    ...(options.length ? { options } : {}), ...(recommended ? { recommended } : {}), ...(endsRun.length ? { endsRun } : {}), ...(detail ? { detail } : {}) }
}

/** An option referenced by id or, leniently, by its exact label. */
export function resolveOptionId(options: QuestionOption[], value: string): string | undefined {
  const needle = value.trim().toLowerCase()
  return options.find(option => option.id === needle)?.id ?? options.find(option => option.label.toLowerCase() === needle)?.id
}

/** The options a pending question interrupt offered (empty for a plain question). */
export function offeredOptions(request: JsonValue | undefined): QuestionOption[] {
  const object = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
  return Array.isArray(object.options) ? boundedOptions(object.options) : []
}

/** The person's answer as the asker reads it: the chosen option spelled out, then their own words when they added any. */
export function answerText(response: JsonValue, request?: JsonValue): string {
  if (typeof response === 'string') return response
  const object = response && typeof response === 'object' && !Array.isArray(response) ? response as JsonObject : undefined
  const answer = typeof object?.answer === 'string' ? object.answer.trim() : ''
  const optionId = typeof object?.optionId === 'string' ? object.optionId : undefined
  const option = optionId ? offeredOptions(request).find(item => item.id === optionId) : undefined
  if (!option) return answer || JSON.stringify(response)
  const chosen = `The person chose "${option.label}"${option.meaning ? ` (${option.meaning})` : ''}.`
  return answer && answer.toLowerCase() !== option.label.toLowerCase() ? `${chosen}\nTheir words: ${answer}` : chosen
}
