# OSS Maintainer Workflow

> For maintainers who want to merge AI-generated PRs quickly without sacrificing quality — and who want to define the conditions under which they trust the pipeline's output.

## The review burden problem

Without guardrails, AI-generated code requires the same review depth as human code. You read every file, verify every edge case, and check every type. The throughput advantage of automation disappears at review time.

specrails adds observable quality signals to every PR: a confidence score from the Reviewer, a security scan from the Security Reviewer, CI results (lint, typecheck, tests), and structured reviewer annotations. These signals are machine-generated and reproducible — not "it looks fine to me."

The goal is not to eliminate code review. It is to define the conditions under which you can trust those signals and reduce manual review to **intent verification**: does this PR do what the original issue asked for? Everything else — correctness, type safety, test coverage, security posture — is covered by the pipeline.

## Setting confidence thresholds

The Reviewer agent scores its own output on a 0–100 scale before creating the PR. You control what happens when that score falls below your threshold via `.claude/confidence-config.json`:

```json
{
  "threshold": 85,
  "on_below_threshold": "block",
  "aspects": {
    "security": { "threshold": 90, "on_below_threshold": "block" },
    "correctness": { "threshold": 80, "on_below_threshold": "warn" }
  }
}
```

The three modes for `on_below_threshold`:

- **`block`** — the pipeline stops before creating the PR. The Reviewer surfaces its concerns and waits. You review the specific low-confidence areas, then add an override comment to the issue to resume.
- **`warn`** — the pipeline continues and creates the PR, but the PR description includes a prominently flagged section listing the low-confidence aspects and the Reviewer's reasoning.
- **`override`** — used by the maintainer at runtime. Add a comment to the issue to explicitly bypass a block for a specific run.

**Recommended starting thresholds for OSS projects**: overall 85 with `block`, security aspect 90 with `block`. The correctness aspect at 80 with `warn` is a reasonable starting point — correctness issues are easier to catch in review than security issues.

Set thresholds based on your risk tolerance, not aspirationally. A threshold of 95 that constantly blocks the pipeline trains you to lower it. A threshold of 85 that rarely blocks but surfaces genuine concerns trains you to trust it.

## Layer convention files as policy

`.claude/rules/frontend.md` is read by the Frontend Reviewer before every review pass. The equivalent files exist for other layers your setup detected. These files are not documentation — they are review policy that the Reviewer enforces on every PR.

Put rules in convention files that you would enforce in a human code review:
- Naming conventions that aren't captured by ESLint (`PascalCase` for component files, `use-` prefix for hook files)
- Required patterns (`cn()` for class merging, `@/` path alias for all imports)
- Forbidden patterns (inline styles, hardcoded color values, `any` types)
- Structural requirements (exported functions must have explicit return types)

What doesn't belong in convention files:
- Style preferences that ESLint or Prettier already enforce (semicolons, trailing commas, quote style)
- Rules that require runtime context to evaluate ("don't use this API in production environments")
- Aspirational guidelines that you don't actually enforce on every PR

The distinction matters because the Reviewer treats convention files as hard rules. A rule in `.claude/rules/frontend.md` that you don't actually enforce in human review creates noise — the Reviewer will flag violations that you approve anyway, eroding trust in the signal.

## The Failure Learning Loop

When the Reviewer finds a non-trivial issue — a pattern that will recur if not captured — it writes a failure record to `.claude/agent-memory/`. Before implementing, the Developer reads failure records matching the current domain and uses them as guardrails.

Over time, systematic mistakes stop appearing in PRs. If the Developer consistently produces type errors in a specific module, the Reviewer notes it, and the next Developer run avoids the pattern. This is not perfect — agents have context limits and memory records are text, not code — but it measurably reduces repeating defects in long-running projects.

As a maintainer, you can seed this loop manually. When you reject a PR for a repeating issue, write a brief failure record in `.claude/agent-memory/` describing the pattern and the correct approach. The Developer will read it on the next relevant implementation. This is particularly effective for project-specific patterns that don't appear in training data — unusual framework choices, internal library conventions, domain-specific invariants.

The memory directory is part of your repository. Reviewing and pruning it periodically keeps the signal quality high. Outdated failure records from refactored code should be removed so they don't mislead future Developers.

## What CI and specrails don't catch

The confidence gate and CI verify quality — not intent. A PR that scores 92 on confidence and passes all CI checks can still be wrong in ways that require human judgment. As a maintainer, the things that remain your responsibility are:

- **Product intent**: does this implementation match what the original issue asked for? The Reviewer verifies the implementation against the spec, but the spec may not have captured the full product intent.
- **UX feel**: for UI features, does the result look and behave right? Automated checks don't evaluate visual weight, interaction feel, or whether the layout works in realistic data conditions.
- **Business logic edge cases**: are there edge cases the spec didn't cover that would produce incorrect behavior for real users? Specs are written before implementation — they capture known cases, not unknown ones.
- **PR description accuracy**: does the PR description accurately describe what changed? This matters for changelog generation and future developers reading git history.

These checks are fast when the pipeline is working well. A PR where the confidence score is high, CI is green, and the implementation is clearly scoped should take 5–10 minutes to verify for intent. That is the target review cost for a well-specced, well-pipelined feature.

## The safe-to-merge checklist

A PR from specrails is safe to merge without deep review when all of the following hold:

- [ ] Overall confidence score is at or above your configured threshold
- [ ] Security aspect score is at or above your configured threshold
- [ ] CI is green: lint, typecheck, and tests all pass
- [ ] No `TODO` or `FIXME` markers were introduced by the implementation
- [ ] PR description matches the original issue intent (read the issue, then the PR — do they describe the same thing?)
- [ ] No new dependencies added without justification in the PR body

When any of these conditions fails, do not skip the review — investigate the specific failure. A `TODO` introduced by the Developer is a signal that it encountered a constraint it couldn't resolve. A CI failure that the Reviewer didn't fix is a signal that the pipeline exited early. A PR description that doesn't match the issue is a signal that scope drifted during implementation.

## Patterns & Anti-patterns

| Pattern | Why it works |
|---------|-------------|
| Setting `security` threshold higher than `overall` | Security issues are harder to catch in a quick review pass — the pipeline should surface them before the PR is created |
| Putting naming conventions in `.claude/rules/` files | The Reviewer enforces them consistently on every PR, so you never see naming violations in review |
| Seeding `.claude/agent-memory/` with project-specific failure records | Prevents the same class of defect from appearing repeatedly; teaches the pipeline your codebase's specific constraints |
| Using `warn` for `correctness` and `block` for `security` | Lets low-stakes correctness issues through for quick human review while stopping security concerns cold |

| Anti-pattern | Why it fails |
|-------------|-------------|
| Treating a high confidence score as a substitute for intent review | Confidence measures implementation quality against the spec, not the spec's alignment with product intent |
| Adding aspirational rules to `.claude/rules/` files | Reviewer flags violations you'd approve anyway, creating noise that erodes trust in the rule set |
| Never pruning `.claude/agent-memory/` | Outdated failure records from refactored code mislead future Developers, causing them to avoid patterns that are now correct |
| Raising thresholds after every blocked PR instead of investigating | The block exists because the pipeline found something; raising the threshold to get the PR through skips the investigation |

## What's next?

- [Customization](customization.md) — configure agents, rules, personas, and confidence thresholds for your project
- [Core Concepts](concepts.md) — understand the pipeline phases and the agent roles that produce the quality signals you're reviewing

---

[← Parallel Development](playbook-parallel-dev.md)
