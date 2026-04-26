import { confirm, input, select } from '@inquirer/prompts'

import { PromptAbortError } from './errors.js'

/**
 * Thin wrappers over `@inquirer/prompts` that add:
 *  - Non-TTY detection → throws {@link PromptAbortError} unless the
 *    caller provided a default, matching the old bash behaviour of
 *    "use the default and don't ask when piped".
 *  - Consistent typing (`string`, `boolean`, `T`) across the call
 *    sites so command handlers don't need to think about `undefined`.
 */

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export interface TextOptions {
  message: string
  /** Value used when stdin is non-TTY. Absence here in non-TTY mode throws. */
  default?: string
  /** Returns error message when invalid, or `true` / undefined when valid. */
  validate?: (value: string) => string | true | undefined
}

export async function text(opts: TextOptions): Promise<string> {
  if (!isInteractive()) {
    if (opts.default === undefined) {
      throw new PromptAbortError(
        `cannot prompt for "${opts.message}" in a non-interactive environment`,
      )
    }
    return opts.default
  }
  return input({
    message: opts.message,
    default: opts.default,
    validate: opts.validate as ((v: string) => string | true) | undefined,
  })
}

export interface ConfirmOptions {
  message: string
  default?: boolean
}

export async function confirmYesNo(opts: ConfirmOptions): Promise<boolean> {
  if (!isInteractive()) {
    if (opts.default === undefined) {
      throw new PromptAbortError(
        `cannot confirm "${opts.message}" in a non-interactive environment`,
      )
    }
    return opts.default
  }
  return confirm({ message: opts.message, default: opts.default })
}

export interface SelectOptions<T> {
  message: string
  choices: Array<{ name: string; value: T; description?: string }>
  default?: T
}

export async function chooseOne<T>(opts: SelectOptions<T>): Promise<T> {
  if (!isInteractive()) {
    if (opts.default === undefined) {
      throw new PromptAbortError(
        `cannot present choices for "${opts.message}" in a non-interactive environment`,
      )
    }
    return opts.default
  }
  return select<T>({
    message: opts.message,
    choices: opts.choices,
    default: opts.default,
  })
}
