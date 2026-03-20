# Product Discovery

> For OSS maintainers using specrails with OpenSpec who want every implementation to land right the first time.

## Why spec quality determines implementation quality

The Architect agent reads your spec before writing a single task. It has no other source of truth. If your proposal is ambiguous, the design it produces will be ambiguous. If the design is ambiguous, the Developer will fill the gaps with assumptions — and those assumptions may not match your intent.

The pipeline is only as good as the spec that enters it. A vague feature request produces code that technically compiles and tests pass, but misses the product intent entirely. A precise, well-structured spec produces a design artifact that the Developer can follow without guessing.

This isn't unique to AI agents. The same dynamic plays out in human teams: the clearer the ticket, the fewer the back-and-forths. With specrails, the cost of ambiguity is higher because there is no back-and-forth — the pipeline runs to completion and surfaces a PR. At that point, the cost to correct a wrong assumption is much higher than the cost to write a better spec upfront.

## Anatomy of a good OpenSpec proposal

OpenSpec proposals have four required fields: What, Why, Non-goals, and Success criteria. Each field should be concrete enough that a reader who has never touched your codebase understands the full scope of the change.

**Vague proposal:**
```
Add a dashboard page showing user stats.
```

This leaves every significant question unanswered: which stats, which users, what layout, what data source, what defines "done"?

**Good proposal:**
```
What: Add a /dashboard route that renders a stats panel for the authenticated user.
The panel shows: total API calls in the last 30 days, current rate limit window status,
and top 3 endpoints by call volume. Data comes from the existing /api/usage endpoint.

Why: OSS users need to self-diagnose rate limit issues without opening a support ticket.
The Product Analyst scored this High on the Developer persona (pain: "I don't know when
I'm about to hit a rate limit").

Non-goals: Historical charts, export functionality, and admin views are out of scope.
This is a read-only display panel.

Success criteria: Authenticated user loads /dashboard and sees accurate stats within 2s.
Unauthenticated user is redirected to /login. All three stat types render correctly
in a 375px viewport. Zero console errors.
```

The difference is not length — it is specificity. The Architect can produce a task breakdown from the good proposal without making a single assumption.

## Writing GitHub Issues the Product Analyst can parse

The Product Analyst reads your GitHub Issues labeled `product-driven-backlog` to build the dependency DAG and score your backlog. The issue body structure matters.

**The `Prerequisites:` field** is how you tell the Product Analyst that one issue depends on another. When you run `/sr:product-backlog`, the dependency DAG is built from these declarations. Issues without prerequisites are Wave 1 candidates — safe to implement in parallel. Issues with prerequisites are scheduled after their dependencies complete.

```
Prerequisites: #71 (rate limiting middleware must exist before we can display rate limit status)
```

Write this field even when the dependency seems obvious. The Product Analyst reads issues in isolation — it doesn't infer dependencies from context.

**VPC-aligned descriptions** help the Product Analyst score your issue accurately. Mention which persona benefits and describe the pain or gain being addressed. "As a developer debugging API integration issues, I need to see my current rate limit window status without making a test request" gives the Product Analyst enough context to score correctly. "Add rate limit display" does not.

**Effort labels** (Low / Medium / High) affect priority scoring. The Product Analyst uses the score-to-effort ratio to rank recommendations. A Low-effort feature with a High score ranks above a High-effort feature with the same score. Set realistic effort labels — optimistic labels inflate priority and create scheduling surprises.

## Choosing your entry point

specrails offers two paths into the OpenSpec pipeline:

**`/opsx:ff` (Fast Forward)** generates all artifacts in one pass: proposal, design, tasks, and context bundle. The Architect runs through each artifact without stopping for review. Use this when:
- You know exactly what you want to build
- The approach is well-understood and not architecturally novel
- You'd approve the design without reading it carefully

**`/opsx:new` + `/opsx:continue`** creates artifacts one at a time, pausing after each. You review the proposal before the design is written, and the design before tasks are generated. Use this when:
- Requirements are still being refined
- The feature touches sensitive architecture areas
- You want to redirect the design approach before tasks are committed
- The feature has security or data-model implications worth reviewing before code is written

Rule of thumb: if you'd accept the Architect's first draft without edits, use `/opsx:ff`. If you want a checkpoint between "what we're building" and "how we're building it," use the step-by-step path.

Once artifacts are complete, `/opsx:apply` hands them to the Developer. After implementation, `/opsx:archive` closes the change.

## The context bundle matters

The context bundle is the set of files, interfaces, and decisions that the Developer reads before writing code. A thin context bundle forces the Developer to explore the codebase independently — and exploration introduces risk. The Developer may read an outdated version of a file, miss a constraint documented elsewhere, or invent types that conflict with existing ones.

A good context bundle includes:
- **Files to read**: specific file paths, not directory globs
- **Key interfaces**: paste the exact TypeScript interface or API contract, not a link to it
- **Architectural decisions**: what approach was chosen and why, so the Developer doesn't choose a different approach that conflicts with the rest of the system
- **Known constraints**: anything that would make the naive implementation wrong (auth requirements, transaction boundaries, rate limits, backward-compatibility rules)

The context bundle is generated automatically by `/opsx:ff` and `/opsx:continue`. You can edit it before running `/opsx:apply`. Investing 10 minutes in tightening the context bundle typically saves 30 minutes of review on the resulting PR.

## Patterns & Anti-patterns

| Pattern | Why it works |
|---------|-------------|
| Proposal includes explicit Non-goals | Prevents scope creep during implementation — the Developer doesn't add "nice to have" features that weren't requested |
| Design artifact describes the approach per layer | Developer has no ambiguity about which files to touch and in what order |
| Context bundle includes exact TypeScript interfaces | Developer doesn't invent types that conflict with existing ones, reducing type errors and review cycles |
| Success criteria are binary (pass/fail) | Easier to verify at review time — "redirects to /login when unauthenticated" is verifiable; "handles auth correctly" is not |

| Anti-pattern | Why it fails |
|-------------|-------------|
| Skipping the design artifact and going straight to tasks | Tasks without design rationale produce code that passes tests but breaks the architecture — the Developer follows the task list without understanding the system intent |
| Spec written after implementation | The spec becomes documentation, not a contract — the pipeline can't use it to validate the implementation against product intent |
| Vague acceptance criteria ("looks good", "works correctly") | The Reviewer can't determine done-ness and the Developer can't verify its own output against a clear bar |
| Missing cross-references in context bundle | Developer reads the wrong version of a file or misses a constraint, producing a PR that requires significant rework |

## What's next?

- [Core Concepts](concepts.md) — understand the pipeline phases and agent roles
- [Workflows & Commands](workflows.md) — the full command reference including OpenSpec commands
- [Customization](customization.md) — adapt the Architect and Developer agents to your project conventions

---

[← Updating](updating.md) · [Parallel Development →](playbook-parallel-dev.md)
