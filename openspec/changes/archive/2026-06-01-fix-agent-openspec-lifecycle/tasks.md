## 1. sr-architect Template

- [x] 1.1 Remove circular self-trigger from frontmatter description in `templates/agents/sr-architect.md` — update description so it does not trigger on `/opsx:ff`; state the agent is launched by orchestrator with a specName argument
- [x] 1.2 Add Step 0 "Scaffold OpenSpec Artifacts" block to Core Responsibilities in `templates/agents/sr-architect.md` — instruct agent to run `/opsx:new <specName>` then `/opsx:ff <specName>` before any design work; prohibit hand-authoring of proposal.md, design.md, tasks.md
- [x] 1.3 Add specName required-argument handling to `templates/agents/sr-architect.md` — agent halts with error message if specName argument is absent

## 2. sr-developer Template

- [x] 2.1 Replace Phase 3 opening in `templates/agents/sr-developer.md` with `/opsx:apply <specName>` invocation — developer does not write files directly; invokes slash command first
- [x] 2.2 Add checkbox verification gate to Phase 3 in `templates/agents/sr-developer.md` — after apply exits, read tasks.md, check for `- [ ]` lines, halt and report incomplete tasks if any found
- [x] 2.3 Add Phase 4 prerequisite note in `templates/agents/sr-developer.md` — explicitly state Phase 4 is unreachable unless Phase 3 checkbox gate passed
- [x] 2.4 Add specName required-argument handling to `templates/agents/sr-developer.md` — agent halts with error message if specName argument is absent

## 3. sr-reviewer Template

- [x] 3.1 Add Workflow Step 5 "Task Completion Gate" to `templates/agents/sr-reviewer.md` — read tasks.md, assert all checkboxes are `[x]`, block if any `- [ ]` remain, report incomplete task titles
- [x] 3.2 Add Workflow Step 6 "Archive" to `templates/agents/sr-reviewer.md` — invoke `/opsx:archive <specName>` only when Step 5 passes
- [x] 3.3 Add specName required-argument handling to `templates/agents/sr-reviewer.md` — agent halts with error message if specName argument is absent

## 4. Installed Agent Files (self-referential)

- [x] 4.1 Mirror Task 1.1 changes to `.claude/agents/sr-architect.md`
- [x] 4.2 Mirror Tasks 1.2–1.3 changes to `.claude/agents/sr-architect.md`
- [x] 4.3 Mirror Tasks 2.1–2.4 changes to `.claude/agents/sr-developer.md`
- [x] 4.4 Mirror Tasks 3.1–3.3 changes to `.claude/agents/sr-reviewer.md`

## 5. Tests

- [x] 5.1 Create `src/installer/__tests__/agent-lifecycle.test.ts` — vitest tests asserting lifecycle invariants for all three template files: opsx:new precedes opsx:ff in architect; opsx:apply present in developer; checkbox gate pattern present in developer; task gate and opsx:archive present in reviewer
- [x] 5.2 Run `npm test` — verify all existing tests pass and new lifecycle tests pass with zero failures
