# specrails-plugin — Claude Code plugin packaging (WIP / NOT published)

> **Status: work in progress. This directory is NOT a live distribution channel.**
> Do not treat the agents/skills here as the runtime source of truth.

This folder packages SpecRails as a [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins)
(the plugin-marketplace distribution model). It is **not currently published or wired up**:

- **Not on npm.** `package.json`'s `files` field ships `bin/ dist/ templates/ commands/ docs/ schemas/` only — `specrails-plugin/` is excluded. `npx specrails-core …` users never receive it.
- **No marketplace index.** Only `.claude-plugin/plugin.json` exists; there is no `marketplace.json`, so it cannot be added via `/plugin marketplace add`.
- **Not referenced** by the installer or any CLI/build code.
- **Not released.** `.github/workflows/release.yml` publishes the npm package only; nothing publishes this plugin.

## The live distribution is the npm installer

The supported, runtime source of truth is the **npm installer**:

```
npx specrails-core@latest init
```

It renders `templates/` (agents, commands, rules) into the target repo's provider directory
(e.g. `.claude/agents/`). When you change agent behaviour, edit **`templates/agents/`** — that is
what actually ships and runs.

## ⚠️ This packaging is stale — re-sync before publishing

The agents/skills under `specrails-plugin/` were copied from `templates/` at an earlier point and
have **drifted**: there is no generator keeping them in sync, so they lag behind recent template
changes (for example, the forced OpenSpec-skill-execution contract in `templates/agents/sr-*.md`).

Before this plugin is ever published, it needs:

1. a `.claude-plugin/marketplace.json` so it can be registered as a marketplace;
2. a re-sync of `agents/`, `skills/`, `hooks/`, `references/` from `templates/` (the current copies
   are outdated and, for the core pipeline agents, do not invoke the official `opsx:*` skills);
3. ideally a **generator** (`templates/` → `specrails-plugin/`) so the two can never diverge again.

Until then, fixes land in `templates/` (and the installed `.claude/agents/` of this repo), not here.
