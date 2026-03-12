---
paths:
  - "*.sh"
  - "install.sh"
---

# Shell Script Conventions

- Always start with `#!/usr/bin/env bash` and `set -euo pipefail`
- Quote all variable expansions: `"${var}"` not `$var`
- Use `local` for function-scoped variables
- Use `[[ ]]` instead of `[ ]` for conditionals
- Use `$()` instead of backticks for command substitution
- Prefer `printf` over `echo` for portability
- Handle errors explicitly — don't rely on `set -e` alone for critical operations
- Ensure compatibility with both macOS and Linux (watch for `sed -i`, `grep -P`, etc.)
- Use meaningful function names and keep functions small
- Add comments for non-obvious logic, especially regex patterns
