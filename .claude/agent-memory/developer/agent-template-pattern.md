---
name: agent-template-pattern
description: How to create new agent template files and their generated instances in specrails
type: project
---

Every new agent requires two files plus a memory directory:

1. `templates/agents/<name>.md` — canonical template with `{{PLACEHOLDER}}` syntax
2. `.claude/agents/<name>.md` — generated instance with all placeholders resolved
3. `.claude/agent-memory/<name>/MEMORY.md` — initial empty memory file

**Why:** templates are copied by install.sh into target repos; the .claude/ copy is used by specrails itself.

**How to apply:** When adding any new agent, always create all three. Never leave a .claude/ agent file with unresolved `{{...}}` strings.

### YAML frontmatter required fields

```yaml
---
name: <kebab-case-name>
description: "Multi-line string with usage examples"
model: sonnet
color: <color-name>
memory: project
---
```

### Assigned colors (do not reuse)
- `green` — architect
- `purple` — developer
- `red` — reviewer
- `orange` — security-reviewer
- `cyan` — test-writer

### Placeholders used by agent templates
- `{{TECH_EXPERTISE}}` — polyglot stack description (resolved from .claude/agents/developer.md)
- `{{LAYER_CLAUDE_MD_PATHS}}` — e.g. `.claude/rules/*.md`
- `{{MEMORY_PATH}}` — e.g. `.claude/agent-memory/<name>/`
- `{{SECURITY_EXEMPTIONS_PATH}}` — security-reviewer specific

### Memory file initial content
```markdown
# <Title Case Name> Agent Memory

No memories recorded yet.
```

### Verification after creating
```bash
grep -r '{{[A-Z_]*}}' .claude/agents/<name>.md 2>/dev/null || echo "OK: no broken placeholders"
```
