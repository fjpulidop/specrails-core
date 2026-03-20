# FAQ

## Setup and installation

**Do I need a Claude API account to use SpecRails?**

Yes. SpecRails runs on top of Claude Code, which requires an Anthropic account. Claude Code handles authentication — SpecRails just orchestrates it. See [Claude Code's installation guide](https://docs.anthropic.com/en/docs/claude-code) for setup.

**What does the installer actually do to my project?**

It creates a `.claude/` directory with agent templates, commands, and configuration files. It does not modify your source code, create commits, or push anything. Your project is unchanged — `.claude/` is the only addition.

**Do I need Node.js if my project is not JavaScript?**

Yes. Node 18+ is required to run `npx specrails-core@latest`. Once installed, SpecRails works with any language or framework — the agents adapt to whatever stack your project uses.

**Can I run SpecRails on a project that doesn't have GitHub Issues?**

Yes. During `/setup`, you can choose "none" as your backlog provider. Commands like `/sr:implement` will accept plain text descriptions instead of issue numbers:

```
/sr:implement "add rate limiting to the API"
```

**How long does /setup take?**

About 5 minutes. Most of the time is spent on Phase 2 (persona generation), which does web research on your domain.

---

## Using SpecRails

**Can I run SpecRails on an existing project with existing code?**

Yes, that's the intended use case. The `/setup` wizard analyzes your existing codebase — your tech stack, layers, CI commands, and conventions — and generates agents configured specifically for it.

**Does /sr:implement always create a PR?**

By default, yes. If you want to preview the changes first without creating commits or a PR, use dry-run mode:

```
/sr:implement --dry-run "add dark mode"
```

Then apply the cached result when you're ready:

```
/sr:implement --apply dark-mode
```

**What happens if the pipeline fails mid-run?**

SpecRails saves pipeline state after each phase. If a run fails, use `/sr:retry` to resume from the last successful phase instead of starting over:

```
/sr:retry dark-mode
```

**Can I implement multiple features at once?**

Yes. Pass multiple issue numbers or descriptions:

```
/sr:implement #42, #43, #44
```

Each feature gets an isolated git worktree. Pipelines run concurrently and the results are merged automatically at the end.

**Can I customize the agents?**

Yes. After setup, the generated agent files are in `.claude/agents/`. Edit them directly to change behavior, add constraints, or update instructions. Changes take effect on the next run.

For layer-specific coding conventions, edit `.claude/rules/*.md`.

**What is a VPC persona?**

VPC stands for Value Proposition Canvas. Personas are structured profiles of your target users with their Jobs (what they're trying to accomplish), Pains (what frustrates them), and Gains (what they want). The Product Manager and Architect use these to make better design decisions. They're generated during `/setup` and stored in `.claude/agents/personas/`.

---

## Project compatibility

**Does SpecRails work with monorepos?**

Yes. During `/setup`, the architect detects your monorepo structure and generates separate layer configurations for each package or service.

**Which languages and frameworks are supported?**

SpecRails works with any stack. The agents are general-purpose and adapt based on what `/setup` detects in your codebase. It's been used with Node.js, Python, Go, Ruby, Rust, and mixed-stack projects.

**Does it work with private repositories?**

Yes, for code generation. For features that require GitHub integration (PR creation, Issue reading), you need the GitHub CLI authenticated against your private repo.

---

## Keeping SpecRails up to date

**How do I update SpecRails?**

Run the installer again in your project:

```bash
npx specrails-core@latest init --root-dir .
```

Then re-run `/setup` to regenerate agents with any new templates. See the [updating guide](../updating.md) for details.

**How do I know which version is installed?**

```bash
cat .specrails-version
```

---

## Troubleshooting

**The /setup command isn't available after installing.**

Claude Code loads commands from `.claude/commands/`. Make sure you opened Claude Code from inside your project directory (the one where you ran `npx specrails-core@latest init`).

**Generated files contain `{{PLACEHOLDER}}` text.**

The `/setup` wizard did not complete all phases. Re-run `/setup` — it will pick up where it left off.

**The pipeline created a PR but the CI checks failed.**

The reviewer agent runs your CI suite and attempts to fix failures automatically. If it can't fix them within its budget, it creates the PR with a note describing what failed and why. You can fix the remaining issues manually or run `/sr:retry` to try the reviewer phase again.

**I got a "409 Conflict" error during a pipeline run.**

This means another agent tried to check out the same issue simultaneously. The pipeline will detect this and stop — re-run the command after the conflicting run finishes.

---

[← Quick Start](quick-start.md) · [CLI Reference →](cli-reference.md)
