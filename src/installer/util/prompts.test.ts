import { describe, expect, it } from 'vitest'

import { PromptAbortError } from './errors.js'
import { chooseOne, confirmYesNo, text } from './prompts.js'

/**
 * We cannot reliably simulate interactive TTY input inside vitest.
 * These tests lock down the non-interactive contract — which is the
 * path specrails-hub uses when it drives the installer headlessly.
 */

describe('prompts (non-TTY behaviour)', () => {
  it('text throws PromptAbortError when default is missing', async () => {
    await expect(text({ message: 'name?' })).rejects.toBeInstanceOf(PromptAbortError)
  })

  it('text returns the default value when non-interactive', async () => {
    const result = await text({ message: 'name?', default: 'alice' })
    expect(result).toBe('alice')
  })

  it('confirmYesNo throws PromptAbortError when default is missing', async () => {
    await expect(confirmYesNo({ message: 'ok?' })).rejects.toBeInstanceOf(PromptAbortError)
  })

  it('confirmYesNo returns the default boolean when non-interactive', async () => {
    expect(await confirmYesNo({ message: 'ok?', default: true })).toBe(true)
    expect(await confirmYesNo({ message: 'ok?', default: false })).toBe(false)
  })

  it('chooseOne throws PromptAbortError when default is missing', async () => {
    await expect(
      chooseOne({
        message: 'pick',
        choices: [
          { name: 'a', value: 'a' },
          { name: 'b', value: 'b' },
        ],
      }),
    ).rejects.toBeInstanceOf(PromptAbortError)
  })

  it('chooseOne returns the default when non-interactive', async () => {
    const result = await chooseOne({
      message: 'pick',
      choices: [
        { name: 'a', value: 'a' },
        { name: 'b', value: 'b' },
      ],
      default: 'b',
    })
    expect(result).toBe('b')
  })
})
