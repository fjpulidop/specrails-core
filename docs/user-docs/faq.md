# FAQ

## Setup and installation

**Do I need a Claude API account to use SpecRails?**

Yes. SpecRails runs on top of Claude Code, which requires an Anthropic account. Claude Code handles authentication — SpecRails just orchestrates it. See [Claude Code's installation guide](https://docs.anthropic.com/en/docs/claude-code) for setup.

**What does the installer actually do to my project?**

The plugin method (`claude plugin install sr`) installs logic into Claude Code's plugin system — nothing is added to your project until you run `/specrails:setup`. The scaffold method (`npx specrails-core@latest init`) copies templates into `.claude/`. Neither method modifies your source code, creates commits, or pushes anything.

**Do I need Node.js if my project is not JavaScript?**

Not for the plugin method (`claude plugin install sr`). Node.js 18+ is only required for the scaffold method (`npx specrails-core@latest init`). Once installed, SpecRails works with any language or framework.

**Do I need GitHub Issues?**

No. SpecRails ships with a built-in local ticket system — no GitHub account required. Local tickets are the default. Commands like `/specrails:implement` accept ticket IDs or plain text:

```
/specrails:implement #1, #4
/specrails:implement "add rate limiting to the API"
```

You can switch to GitHub Issues or JIRA during `/specrails:setup` (Phase 3) if you prefer.

**How long does /specrails:setup take?**

The full wizard takes about 5 minutes — most of the time is Phase 2 (persona research via web search). For a faster start, use `/specrails:setup --lite`: three questions, under a minute, no web research.

---

## Using SpecRails

**Can I run SpecRails on an existing project with existing code?**

Yes, that's the intended use case. The `/specrails:setup` wizard analyzes your existing codebase — your tech stack, layers, CI commands, and conventions — and generates agents configured specifically for it.

**Does /specrails:implement always create a PR?**

By default, yes. If you want to preview the changes first without creating commits or a PR, use dry-run mode:

```
/specrails:implement --dry-run "add dark mode"
```

Then apply the cached result when you're ready:

```
/specrails:implement --apply dark-mode
```

**What happens if the pipeline fails mid-run?**

SpecRails saves pipeline state after each phase. If a run fails, use `/specrails:retry` to resume from the last successful phase instead of starting over:

```
/specrails:retry dark-mode
```

**Can I implement multiple features at once?**

Yes. Pass multiple issue numbers or descriptions:

```
/specrails:implement #42, #43, #44
```

Each feature gets an isolated git worktree. Pipelines run concurrently and the results are merged automatically at the end.

**Can I customize the agents?**

Yes. With the plugin method, edit your project data files in `.specrails/` — personas, rules, config. With the scaffold method, agent files in `.claude/agents/` are also directly editable. Changes take effect on the next run.

For layer-specific coding conventions, edit `.specrails/rules/*.md` (plugin) or `.claude/rules/*.md` (scaffold).

**What is a VPC persona?**

VPC stands for Value Proposition Canvas. Personas are structured profiles of your target users with their Jobs (what they're trying to accomplish), Pains (what frustrates them), and Gains (what they want). The Product Manager and Architect use these to make better design decisions. They're generated during `/specrails:setup` and stored in `.specrails/personas/` (plugin) or `.claude/agents/personas/` (scaffold).

---

## Project compatibility

**Does SpecRails work with monorepos?**

Yes. During `/specrails:setup`, the architect detects your monorepo structure and generates separate layer configurations for each package or service.

**Which languages and frameworks are supported?**

SpecRails works with any stack. The agents are general-purpose and adapt based on what `/specrails:setup` detects in your codebase. It's been used with Node.js, Python, Go, Ruby, Rust, and mixed-stack projects.

**Does it work with private repositories?**

Yes, for code generation. For features that require GitHub integration (PR creation, Issue reading), you need the GitHub CLI authenticated against your private repo.

---

## Keeping SpecRails up to date

**How do I update SpecRails?**

Plugin method:

```bash
claude plugin update sr
```

Scaffold method:

```bash
npx specrails-core@latest init --root-dir .
```

Then re-run `/specrails:setup` to regenerate project data with any new templates. See the [updating guide](../updating.md) for details.

**How do I know which version is installed?**

```bash
cat .specrails-version
```

---

## Troubleshooting

**The /specrails:setup command isn't available after installing.**

For the plugin method: make sure the plugin is installed (`claude plugin list` should show `sr`). For the scaffold method: Claude Code loads commands from `.claude/commands/` — make sure you opened Claude Code from inside your project directory.

**Generated files contain `{{PLACEHOLDER}}` text.**

The `/specrails:setup` wizard did not complete all phases. Re-run `/specrails:setup` — it will pick up where it left off.

**The pipeline created a PR but the CI checks failed.**

The reviewer agent runs your CI suite and attempts to fix failures automatically. If it can't fix them within its budget, it creates the PR with a note describing what failed and why. You can fix the remaining issues manually or run `/specrails:retry` to try the reviewer phase again.

**I got a "409 Conflict" error during a pipeline run.**

This means another agent tried to check out the same issue simultaneously. The pipeline will detect this and stop — re-run the command after the conflicting run finishes.

---

[← Quick Start](quick-start.md) · [CLI Reference →](cli-reference.md)
