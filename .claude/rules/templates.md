---
paths:
  - "templates/**"
---

# Template conventions

- The only placeholder is `{{PROJECT_NAME}}`; unknown `{{TOKENS}}` render as empty strings, so do not add new ones.
- Slash commands live in `templates/commands/specrails/` and are the single source for every provider (Codex skills, Gemini TOML and Kimi skills are generated from them).
- Frontmatter uses YAML with `---` delimiters; file names are kebab-case.
- Every template change affects every installed project: cover it in `src/installer/**/scaffold*.test.ts`.
