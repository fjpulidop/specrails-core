# Placeholder False Positives

When grepping for `{{[A-Z_]*}}` in generated instance files (`.claude/agents/*.md`), some matches are documentation prose inside backtick code spans, not actual unresolved placeholders. Examples:

- architect.md line 71: `- Markdown templates: Use \`{{PLACEHOLDER}}\` syntax for template variables`
- developer.md line 92: `- **Templates**: Every \`{{PLACEHOLDER}}\` must be documented...`
- reviewer.md line 71: `- Template placeholder style is consistent (\`{{UPPER_SNAKE_CASE}}\`)`

These are intentional — they describe the placeholder convention. They are NOT broken substitutions. A true unresolved placeholder would be a standalone `{{SOME_VAR}}` on its own line or mid-sentence without surrounding backticks and without being part of a "the format is X" explanation.

Rule: check whether the match is in a `code span` or ` ```block``` ` that describes the template format. If yes, it's a false positive.
