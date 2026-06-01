## Why

The sr-architect, sr-developer, and sr-reviewer agent templates bypass the OpenSpec lifecycle entirely: they hand-author artifacts, simulate task completion, and archive without verifying task state. This means tasks.md checkboxes are never real, `/opsx:archive` is never invoked structurally, and the lifecycle enforcement that OpenSpec provides is illusory.

## What Changes

- **sr-architect**: Gains a mandatory Step 0 that invokes `/opsx:new <specName>` then `/opsx:ff <specName>` before doing any design work. Prohibited from hand-authoring proposal.md, design.md, or tasks.md. Circular self-trigger removed from frontmatter description.
- **sr-developer**: Phase 3 is replaced with an `/opsx:apply <specName>` invocation. A checkbox verification gate is added: the developer must not hand off to the reviewer until all tasks in tasks.md show `[x]`.
- **sr-reviewer**: A Task Completion Gate (Step 5) is added that reads tasks.md and blocks if any `[ ]` remain. Step 6 invokes `/opsx:archive <specName>` — only reachable if Step 5 passes.
- **specName propagation**: All three agents explicitly require `specName` as a positional invocation argument and halt if it is not provided.

## Capabilities

### New Capabilities

- `agent-openspec-lifecycle`: Contract governing how sr-architect, sr-developer, and sr-reviewer invoke OpenSpec slash commands (`/opsx:new`, `/opsx:ff`, `/opsx:apply`, `/opsx:archive`) in the correct order, with enforcement gates at each handoff boundary.

### Modified Capabilities

<!-- No existing specs cover agent lifecycle command invocation. This is a new capability. -->

## Impact

- `templates/agents/sr-architect.md` — frontmatter description, Core Responsibilities section
- `templates/agents/sr-developer.md` — Phase 3 and Phase 4 transition gate
- `templates/agents/sr-reviewer.md` — Workflow steps 5 and 6
- `.claude/agents/sr-architect.md`, `.claude/agents/sr-developer.md`, `.claude/agents/sr-reviewer.md` — installed copies (self-referential: specrails-core uses its own agents)
- Meta-tool impact: all target repos that run `specrails-core init` or `specrails-core update` will receive updated agent templates
