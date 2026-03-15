# Convention Inference Prompt

Analyze source files to infer coding conventions and patterns used in this project.

## How to Analyze

For each detected layer (backend, frontend, core, etc.):

1. **Read 3-5 representative files** from that layer
   - Pick files that are central to the layer (routes, components, services, models)
   - Prefer files with 50-200 lines (enough to show patterns without being overwhelming)
   - Avoid auto-generated files, config files, or test files for primary analysis

2. **Identify these patterns:**

### Naming
- Variable naming: snake_case, camelCase, PascalCase
- Function naming: snake_case, camelCase
- Class/Type naming: PascalCase, SCREAMING_SNAKE
- File naming: kebab-case, snake_case, PascalCase
- Test naming: `test_behavior`, `describe/it`, `Test_Behavior`

### Code Organization
- Import ordering (stdlib → third-party → local)
- Module structure (one class per file, multiple, etc.)
- Export patterns (named exports, default exports, barrel files)
- Separation of concerns (where does business logic live?)

### Error Handling
- Exception types (custom exceptions, error codes, Result types)
- Error propagation (throw, return errors, Result/Option)
- API error format (structured error responses, HTTP status codes)
- Validation approach (Pydantic, Zod, custom validators)

### Testing
- Test framework (pytest, vitest, jest, go test)
- Test organization (mirrored structure, flat, grouped by type)
- Mocking approach (unittest.mock, jest.mock, testify)
- Fixture patterns (pytest fixtures, setup/teardown, factory functions)
- Test isolation concerns (scope, cleanup, temp directories)

### API Patterns
- Style (REST, GraphQL, tRPC, gRPC)
- Route organization (resource-based, feature-based)
- Middleware usage (auth, logging, rate limiting)
- Request/response types (Pydantic, TypeScript interfaces, protobuf)

### State Management (frontend)
- Server state (TanStack Query, SWR, Redux Query)
- Client state (Context, Zustand, Redux, Jotai)
- Form handling (React Hook Form, Formik, native)

### Database/Storage
- Access pattern (Repository, DAO, Active Record, raw queries)
- ORM (SQLAlchemy, Prisma, GORM, Diesel)
- Migration tool (Alembic, Prisma Migrate, golang-migrate)
- Connection management (pool, per-request, singleton)

## Output Format

For each layer, produce a concise list of conventions suitable for a `.claude/rules/{layer}.md` file:

```markdown
# {Layer Name} Conventions

- Convention 1: description
- Convention 2: description
- Convention 3: description
...
```

Keep each convention to one line. Focus on patterns that a developer needs to follow when writing new code in this layer.
