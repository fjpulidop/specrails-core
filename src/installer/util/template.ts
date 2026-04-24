/**
 * Small in-house template renderer. Replaces the bash heredocs the
 * retired install.sh / update.sh used to emit manifests and config
 * files.
 *
 * Syntax (intentionally minimal):
 *   ${VAR_NAME}                  — value interpolation
 *   {{#if FLAG}}block{{/if}}     — conditional block, rendered when
 *                                  FLAG is truthy in the context
 *   {{#ifnot FLAG}}block{{/ifnot}} — conditional block when FLAG is falsy
 *
 * Nested blocks are NOT supported. If a template outgrows this
 * capability we switch to mustache — but every heredoc we've audited
 * fits inside these three forms.
 */

export type TemplateContext = Record<string, string | boolean | number | null | undefined>

/**
 * Renders `template` by evaluating its directives against `context`.
 * Missing interpolation variables render as the empty string rather
 * than throwing — the bash scripts behaved the same way (`${X:-}` in
 * a heredoc). Unknown flags in an `{{#if}}` are treated as falsy.
 */
export function render(template: string, context: TemplateContext): string {
  let out = template
  // 1. Handle conditionals first so their variables don't get
  //    interpolated if the block is skipped.
  out = renderConditionals(out, context)
  // 2. Interpolate variables.
  out = renderInterpolations(out, context)
  return out
}

function renderConditionals(input: string, context: TemplateContext): string {
  const ifRegex = /{{#if\s+([A-Z0-9_]+)\s*}}([\s\S]*?){{\/if}}/g
  const ifnotRegex = /{{#ifnot\s+([A-Z0-9_]+)\s*}}([\s\S]*?){{\/ifnot}}/g

  let out = input
  out = out.replace(ifRegex, (_match, name: string, body: string) => {
    return truthy(context[name]) ? body : ''
  })
  out = out.replace(ifnotRegex, (_match, name: string, body: string) => {
    return truthy(context[name]) ? '' : body
  })
  return out
}

function renderInterpolations(input: string, context: TemplateContext): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = context[name]
    if (value === null || value === undefined || value === false) return ''
    return String(value)
  })
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (value === false) return false
  if (value === '' || value === 0) return false
  return true
}
