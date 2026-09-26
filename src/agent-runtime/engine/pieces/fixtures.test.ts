import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { validateWorkflowDefinition } from '../definition-validator.js'
import { validationPieceRegistry } from './index.js'

it('publishes runnable examples from the same effect-free production catalog', () => {
  const root = new URL('../__fixtures__/', import.meta.url)
  for (const file of readdirSync(root).filter(file => file.endsWith('.json'))) {
    const definition = JSON.parse(readFileSync(new URL(file, root), 'utf8'))
    const result = validateWorkflowDefinition(definition, validationPieceRegistry(), { architect: { access: 'read' }, developer: { access: 'write' }, reviewer: { access: 'read' } })
    expect(result, fileURLToPath(new URL(file, root)) + ': ' + JSON.stringify(result.ok ? [] : result.errors)).toMatchObject({ ok: true })
  }
})
