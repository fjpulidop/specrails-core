---
paths:
  - "templates/**"
  - ".claude/setup-templates/**"
---

# Template Conventions

- Use `{{UPPER_SNAKE_CASE}}` for all template placeholders
- Every placeholder must be documented in the setup wizard or a README
- Template files are Markdown — follow standard Markdown formatting
- Frontmatter uses YAML with `---` delimiters
- File naming: kebab-case (e.g., `product-manager.md`, not `productManager.md`)
- Test that placeholders render correctly after substitution — no leftover `{{...}}` in output
- Keep templates focused — one agent/command/rule per file
- Include example values in comments when the placeholder purpose isn't obvious
