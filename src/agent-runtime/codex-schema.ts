/** Codex strict output requires all object keys; optional values travel as null. */
export function codexOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(schema)
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(result[key])) result[key] = (result[key] as Record<string, unknown>[]).map(codexOutputSchema)
  if (result.items && typeof result.items === 'object') result.items = codexOutputSchema(result.items as Record<string, unknown>)
  if (result.properties && typeof result.properties === 'object') {
    const required = new Set(Array.isArray(result.required) ? result.required : [])
    result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => {
      const child = codexOutputSchema(value as Record<string, unknown>)
      return [key, required.has(key) ? child : { anyOf: [child, { type: 'null' }] }]
    }))
    result.required = Object.keys(result.properties as object)
    result.additionalProperties = false
  }
  return result
}
/** Restore only originally optional nulls; required fields remain subject to validation. */
export function restoreOptionalFields(value: unknown, schema: Record<string, unknown>): unknown {
  if (Array.isArray(value) && schema.items) return value.map(item => restoreOptionalFields(item, schema.items as Record<string, unknown>))
  if (!value || typeof value !== 'object' || Array.isArray(value) || !schema.properties) return value
  const properties = schema.properties as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !(key in properties && item === null && !required.has(key)))
    .map(([key, item]) => [key, properties[key] ? restoreOptionalFields(item, properties[key]) : item]))
}
