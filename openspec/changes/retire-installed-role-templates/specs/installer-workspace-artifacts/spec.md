## ADDED Requirements

### Requirement: Core ships no role agent templates
The Core package SHALL NOT contain role agent templates (`templates/agents/**`, `templates/codex-skills/rails/**`). Role behaviour is defined only by the programmatic runtime.

#### Scenario: Package inventory
- **WHEN** the package template inventory is listed
- **THEN** it contains `commands`, `kimi` and `settings` and no `agents` or `codex-skills` directory

#### Scenario: No role identifiers in the repository
- **WHEN** the repository is searched for `sr-architect`, `sr-developer` or `sr-reviewer` outside `CHANGELOG.md` and `openspec/`
- **THEN** no match is found

### Requirement: Fresh workspaces contain no role artifacts
For every provider (claude, codex, gemini, kimi), `init`, `install-framework` and `assemble` SHALL place commands, workflow skills, OpenSpec skills, provider settings and the runtime, and SHALL NOT create `sr-*` role files, role agent-memory directories, Gemini role acknowledgments or an `agents/` directory.

#### Scenario: Fresh claude workspace
- **WHEN** a claude workspace is assembled from a fresh framework
- **THEN** `.claude/commands/specrails/implement.md` exists and `.claude/agents` does not exist

#### Scenario: Fresh codex, gemini and kimi workspaces
- **WHEN** codex, gemini and kimi workspaces are assembled from a fresh framework
- **THEN** `.codex/skills/rails`, `.gemini/agents` and `.kimi-code/skills/sr-*` do not exist while their commands, workflow skills and runtime do

### Requirement: Assemble prunes stale role artifacts and preserves reserved files
When a workspace still holds framework-owned role artifacts from an older Core, `assemble` SHALL remove them: `agents/sr-*.md` symlinks and regular files (claude, gemini), `skills/rails/sr-*` and an emptied `skills/rails/` (codex), `skills/sr-*` (kimi). It SHALL NOT modify, move or delete `custom-*` files or any other user file.

#### Scenario: Old claude workspace
- **WHEN** `.claude/agents` holds a symlink `sr-developer.md`, a copied `sr-reviewer.md` and a user `custom-serena.md`
- **THEN** after assemble only `custom-serena.md` remains, byte-identical

#### Scenario: Old kimi and codex workspaces
- **WHEN** `.kimi-code/skills/sr-architect/SKILL.md` and `.codex/skills/rails/sr-developer/SKILL.md` exist next to `custom-*` skills
- **THEN** after assemble the `sr-*` directories are gone and the `custom-*` skills are unchanged

### Requirement: Installed workspaces are recognised by commands and runtime
`init` SHALL treat a provider workspace as already carrying Core artifacts when its workflow commands or runtime are present, and SHALL NOT require role files for that decision.

#### Scenario: Reinstall over a commands-only workspace
- **WHEN** `init` runs over a workspace that has `.claude/commands/specrails/implement.md` and no `.claude/agents`
- **THEN** it reports the existing installation and does not warn about missing roles
