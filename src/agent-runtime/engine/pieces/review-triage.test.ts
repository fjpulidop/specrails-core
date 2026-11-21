import { describe, expect, it } from 'vitest'
import { triageReviewIssues, withdrawnPhrases } from './review-triage.js'

const kinds = (issues: unknown[], options: Parameters<typeof triageReviewIssues>[1] = {}) => {
  const { actionable, nonActionable } = triageReviewIssues(issues, options)
  return { actionable, kinds: nonActionable.map(item => item.kind) }
}

describe('review triage: issues the run cannot act on', () => {
  it('classifies the Tauri rejections (a regenerated Cargo.lock, an edit to the frozen design.md)', () => {
    const issues = ['Delete src-tauri/Cargo.lock: it is out-of-scope churn not listed in the blast radius.',
      'Amend design.md to record that cargo test runs with --manifest-path src-tauri/Cargo.toml.']
    expect(kinds(issues, { change: 'tauri-search' })).toEqual({ actionable: [], kinds: ['regenerated-lockfile', 'frozen-artifact'] })
  })

  it('classifies checks only a device, simulator or manual pass can make', () => {
    expect(kinds(['Acceptance criterion 3 is only provable on a real iPhone.', 'Run the app in the iOS Simulator to confirm the list scrolls.',
      'Host verification did not run xcodebuild for the app target.', 'The layout needs manual testing in a browser.'])).toEqual({ actionable: [], kinds: ['host-only-check', 'host-only-check', 'host-only-check', 'host-only-check'] })
  })

  it('keeps every genuine rejection actionable, including mixed issues', () => {
    const genuine = [
      'The search handler ignores the empty query: return all items and add a unit test for it.',
      'Verify on a real device and add a snapshot test for the compact layout.',
      'Revert the unrelated edits to src/main.rs and Cargo.lock.',
      'Cargo.lock now pulls serde 2 although no task adds a dependency; remove the dependency from Cargo.toml.',
      'Update design.md and fix the off-by-one in paginate().',
      'The code does not match design.md: the cache must be keyed by user id.',
      'No test covers the score reset; add one to the configured vitest suite.',
      { title: 'Missing error path', description: 'fetchUser swallows network errors' },
    ]
    expect(kinds(genuine, { change: 'feature' })).toEqual({ actionable: genuine, kinds: [] })
  })

  it('honours a criterion the person withdrew in an answer, and only that one', () => {
    const answers = ['Drop O(1) and uniqueness; keep the rest.']
    expect(withdrawnPhrases(answers)).toEqual(['O(1)', 'uniqueness'])
    expect(kinds(['Lookup is O(n), the spec requires O(1).', 'Duplicate keys break uniqueness.', 'Insert does not persist the value.'], { answers })).toEqual({
      actionable: ['Insert does not persist the value.'], kinds: ['withdrawn-criterion', 'withdrawn-criterion'] })
    expect(kinds(['Lookup is O(n), the spec requires O(1).'])).toEqual({ actionable: ['Lookup is O(n), the spec requires O(1).'], kinds: [] })
  })
})
