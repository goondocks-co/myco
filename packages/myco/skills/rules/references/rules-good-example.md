# Rules File — Good Example

This is an example of a well-structured, enforceable CLAUDE.md. Use it as a reference when auditing or writing rules files.

---

# Patchwork — Project Rules

Patchwork is a REST API for managing deployment patches across distributed services. TypeScript, Express, PostgreSQL, Prisma.

## Non-Goals

Patchwork is **not**:

- A general-purpose deployment orchestrator — it manages patches, not full deployments
- A monitoring or alerting system — it integrates with existing observability tools
- A CI/CD pipeline — it is triggered by pipelines, not a replacement for them
- A multi-tenant SaaS — it runs per-organization with no tenant isolation layer

## Architecture Invariants

### Layering

- Route handlers (`src/routes/`) parse requests and delegate to services. No business logic in route handlers.
- Services (`src/services/`) contain all business logic. Services MUST NOT import from `src/routes/`.
- Database access MUST go through Prisma client in `src/db/client.ts`. No raw SQL outside of Prisma migrations.
- Shared types live in `src/types/`. Do not define request/response types inline in route handlers.

### Validation

- All request input MUST be validated with Zod schemas before accessing the request body.
- Zod schemas live in `src/schemas/` alongside the routes that use them.
- Error responses MUST use the `ApiError` class from `src/errors.ts`. Do not throw raw `Error` objects from route handlers.

### Dependencies

- New dependencies MUST be approved before installation. Check if an existing dependency already covers the use case.
- Prefer `node:` built-in modules over third-party packages for crypto, path, fs, and URL operations.

## Golden Paths

### Add a new API endpoint

1. Define the Zod schema in `src/schemas/<resource>.ts`
2. Create or update the service in `src/services/<resource>.ts`
3. Add the route handler in `src/routes/<resource>.ts`
4. Register the route in `src/routes/index.ts`
5. Write integration tests in `tests/routes/<resource>.test.ts`
6. Update OpenAPI spec in `docs/openapi.yaml`

Copy `src/routes/patches.ts` as the canonical example for a new endpoint.

### Fix a bug

1. Write a failing test that reproduces the bug
2. Fix the bug with the minimal change
3. Verify the test passes
4. Check for similar patterns elsewhere in the codebase

### Add a database migration

1. Modify the Prisma schema in `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name <descriptive-name>`
3. Update affected services and types
4. Test with `npm run test:integration`

## Quality Gates

Before committing, ALL of the following MUST pass:

```bash
npm run lint          # ESLint + Prettier
npm run typecheck     # tsc --noEmit
npm test              # Vitest unit + integration tests
```

Test coverage for new code MUST be ≥ 80%. Run `npm run test:coverage` to check.

Commit messages MUST follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

---

## Why This Rules File Works

1. **Explicit non-goals** — Agents know what NOT to build. "Not a deployment orchestrator" prevents scope creep.
2. **Anchored architecture** — "Copy `src/routes/patches.ts`" is enforceable. "Follow good patterns" is not.
3. **Specific validation rule** — "Zod schemas in `src/schemas/`" leaves no room for interpretation.
4. **Step-by-step golden paths** — Agents follow a checklist, not vibes.
5. **Concrete quality gates** — Exact commands, exact coverage threshold, exact commit format.
6. **RFC 2119 language** — MUST vs SHOULD is unambiguous. Every rule is clear about whether exceptions exist.
