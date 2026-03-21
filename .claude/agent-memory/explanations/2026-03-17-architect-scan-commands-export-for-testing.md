---
agent: architect
feature: automated-test-writer-agent
tags: [testing, config, export, vitest]
date: 2026-03-17
---

## Decision

`scanCommands` in `server/config.ts` is exported so it can be tested in isolation in `server/test-writer.test.ts`.

## Why This Approach

`scanCommands` is a pure function (takes a directory path, returns `CommandInfo[]`). It is currently private, but there is no reason to hide it — it has no side effects and no circular dependencies. Exporting it follows the principle that testable units should be accessible. The alternative (testing via `getConfig`) would force the test to mock all GitHub/JIRA CLI detection and git commands just to test frontmatter parsing, which is noise unrelated to what the test is verifying.

## Alternatives Considered

- Test via `getConfig` only: Requires more mocks, tests more than one thing per test case.
- Create a separate module for `scanCommands`: Unnecessary indirection for a single function.

## See Also

- `server/config.ts` — line ~164
- `server/config.test.ts` — existing test pattern showing how `getConfig` is tested
