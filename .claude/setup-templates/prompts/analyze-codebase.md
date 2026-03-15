# Codebase Analysis Prompt

Analyze this repository to understand its architecture, stack, and conventions.

## What to detect

### 1. Languages & Frameworks
- Scan for language-specific files: `*.py`, `*.ts`, `*.tsx`, `*.js`, `*.go`, `*.rs`, `*.java`, `*.kt`, `*.rb`, `*.cs`, `*.swift`
- Check dependency files: `requirements.txt`, `pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `*.csproj`
- Identify frameworks from imports: FastAPI, Django, Flask, Express, Next.js, React, Vue, Angular, Spring, Gin, Actix, Rails, etc.

### 2. Architecture Layers
For each detected layer, identify:
- **Name**: e.g., "Backend", "Frontend", "Core", "API", "Mobile", "CLI"
- **Path**: e.g., `backend/`, `src/`, `frontend/`, `app/`, `lib/`
- **Tech**: e.g., "FastAPI (Python)", "React + TypeScript", "Go package"
- **Tag**: e.g., `[backend]`, `[frontend]`, `[core]`, `[mobile]`, `[test]`

### 3. CI/CD Commands
Parse `.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile`, `Makefile`, `package.json` scripts to find:
- **Lint** commands (ruff, eslint, golangci-lint, clippy, rubocop)
- **Format** commands (ruff format, prettier, gofmt, rustfmt)
- **Test** commands (pytest, vitest, jest, go test, cargo test)
- **Build** commands (tsc, vite build, go build, cargo build)
- **Type check** commands (tsc --noEmit, mypy, pyright)

### 4. Conventions
Read 3-5 representative source files from each layer to detect:
- Naming style (snake_case, camelCase, PascalCase)
- Import organization patterns
- Error handling approach
- Testing patterns (framework, mocking, fixtures)
- API style (REST, GraphQL, tRPC, gRPC)
- State management (if frontend)
- Database access pattern (ORM, raw SQL, repository pattern)

### 5. Project Warnings
Look for:
- Concurrency constraints
- Authentication patterns
- State management gotchas
- Known test isolation issues
- Environment-specific behavior

## Output Format

Return a structured analysis:

```yaml
project:
  name: "project-name"
  description: "One-line description"

stack:
  - layer: "Backend"
    tech: "FastAPI (Python 3.11)"
    path: "backend/"
    tag: "[backend]"
  - layer: "Frontend"
    tech: "React 19 + TypeScript + Vite"
    path: "frontend/"
    tag: "[frontend]"

ci:
  backend:
    lint: "ruff check ."
    format: "ruff format --check ."
    test: "pytest tests/ -q"
  frontend:
    lint: "npm run lint"
    typecheck: "npx tsc --noEmit"
    test: "npx vitest run"

conventions:
  backend:
    - "Routes are thin: validate → call service → return model"
    - "Services own business logic"
    - "Repository pattern for data access"
  frontend:
    - "Functional components with hooks"
    - "TanStack Query for server state"
    - "Tailwind for styling"

warnings:
  - "Auth: All endpoints require authentication"
  - "Tests: Fixtures must use scope='function'"
```
