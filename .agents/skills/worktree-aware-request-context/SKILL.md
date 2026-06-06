---
name: myco:worktree-aware-request-context
description: |
  Implement callerRoot vs projectRoot separation in MycoRequestContext,
  design filesystem API patterns with proper root classification,
  establish request context propagation, and architect worktree-bleed
  prevention. Covers request context design, filesystem root classification,
  API boundary patterns, and worktree-bleed prevention architecture.
  Essential for maintaining proper separation between project identity
  and caller locality in worktree environments.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Worktree-Aware Request Context and Filesystem Root Management

MycoRequestContext separates project identity from caller locality through dual filesystem roots. This prevents worktree-bleed bugs where operations meant for the caller's actual working directory incorrectly use the canonical project root instead. All context-switching headers require bearer token authentication to prevent unauthorized cross-project access.

## Prerequisites

- Understanding of MycoRequestContext structure and flow
- Familiarity with Grove registration and project identity concepts
- Knowledge of worktree patterns and potential bleed scenarios
- Access to `packages/myco/src/grove/request-context.ts` and related request handling code
- Understand that context-switching headers require daemon authentication tokens

## Procedure A: Implement callerRoot vs projectRoot Separation

When designing or modifying request context handling:

1. **Preserve both roots in MycoRequestContext**:
   ```typescript
   interface MycoRequestContext {
     projectRoot: string;      // Canonical, registered project identity
     callerRoot: string | null; // Caller's actual cwd, preserved untouched
     projectId: string;        // Sole identity for DB operations
     tenancySource: TenancySource; // How this context was established
     // ... other fields
   }
   ```

   **TenancySource tri-value model** (defined in `packages/myco/src/grove/request-context.ts`):
   - `'caller'` — context established by an authenticated caller (e.g., `launchContextTenancy: true` in CLI launch options, or explicit context-switching headers)
   - `'synthesized'` — context built internally by the daemon without a specific project binding (e.g., daemon-global or machine-scoped background work that must NOT be Grove-bound)
   - `'daemon'` — context resolved from the Grove registry by the daemon for project-scoped background work (e.g., `canopy-describe`, `canopy-map` scheduled tasks). Use `'daemon'` instead of `'synthesized'` for tasks that must operate within a specific project's Grove context. When scheduled tasks ran as `'synthesized'`, they resolved to `GLOBAL_SCOPE` and returned zero Grove-bound rows — this silently broke `canopy-of-cortex` before `'daemon'` was introduced as the project-scoped background source.

   Use `isCallerTenancy(context)` to check if the context originated from an authenticated caller request. Note: `isCallerTenancy` returns `true` for both `'caller'` and `'daemon'` — both are considered project-bound tenancy sources.

2. **Populate callerRoot from headers/environment**:
   - Read from `x-myco-caller-root` header or `MYCO_CALLER_ROOT` environment variable
   - Preserve the raw value without registry resolution
   - Set to `null` when no caller cwd is supplied (synthesized contexts)

3. **Keep projectRoot for identity operations**:
   - Continue using existing `x-myco-project-root` with spoofing guards
   - Resolve through Grove registry for canonical project identity
   - Never vary this value across worktrees of the same project

4. **Implement the canonical helper**:
   ```typescript
   function filesystemRootFromRequestContext(context: MycoRequestContext): string {
     return context.callerRoot ?? context.projectRoot;
   }
   ```

## Procedure B: Classify Filesystem Operations by Root Type

For each filesystem operation, determine the correct root using this decision tree:

1. **Identity operations** (must not vary across worktrees):
   - Vault database paths: `vaultDbPath(context.projectRoot)`
   - Grove registration: `loadGroveRecord(context.projectRoot)`
   - Persistent session rows and team-sync keys
   - Background scans and daemon maintenance
   - **Always use**: `context.projectRoot`

   **Dual-helper pattern for DB project ID**:
   - `rowProjectIdFromRequestContext(context)` — returns `null` when no project is bound; safe for optional project scoping (e.g., observability tools where project context is optional)
   - `requireProjectId(context, label)` — throws with a descriptive label if no project is bound; use when a project is mandatory for the operation (e.g., saving plans, cortex lookups)

2. **Caller-local operations** (must follow user's actual cwd):
   - Plan watch directories and file monitoring operations
   - Hook saves and MCP file operations
   - Config-relative path resolution: `path.resolve(root, configPath)`
   - File mention and transcript source discovery
   - Stop-time plan reconciliation and source path keys
   - **Always use**: `filesystemRootFromRequestContext(context)` or `context.callerRoot ?? context.projectRoot`

3. **Database identity operations** (project-scoped tables):
   - Canopy entries joins: use `context.projectId`
   - Session records: use `context.projectId`
   - **Never use filesystem roots for DB identity**

## Procedure C: Handle Canopy-Specific Root Requirements

Canopy operations require careful separation of file path canonicalization from project identity:

1. **Hook request handling**:
   - Canonicalize file paths against `context.callerRoot` for Pre/PostToolUse
   - Populate `MYCO_CALLER_ROOT` from hook's actual cwd in agent harnesses
   - Fall back to `context.projectRoot` when `callerRoot` is null

2. **Canopy scanning and entries**:
   - Keep scanning on `context.projectRoot` (identity-keyed operation)
   - Join `canopy_entries` by `sessions.project_id`, not filesystem paths
   - Prevent conflicting canopy rows from multiple worktrees

3. **Event dispatch and statistics**:
   - Use `context.callerRoot` for file path canonicalization in `/canopy/inject`
   - Prefer normalized `activities.file_path` over raw `tool_input` paths
   - Maintain project identity separation in aggregation queries

## Procedure D: Request Context Authentication and Authorization

All request context headers that switch identity must be accompanied by a valid daemon authentication token. This prevents unauthorized cross-project access and ensures proper authorization boundaries.

### Bearer Token Requirement

Context-switching headers (`x-myco-project-root`, `x-myco-project-id`, `x-myco-grove-id`) must include an `Authorization` header with a valid daemon bearer token:

```typescript
interface RequestContextAuthOptions {
  authToken: string; // Bearer token from daemon.json
  source: 'environment' | 'header';
}

// Headers MUST include:
// Authorization: Bearer <daemon-auth-token>
// x-myco-project-root: /path/to/project
// x-myco-project-id: proj_xxx
```

### Token Resolution Patterns

For environments where context is passed via headers (e.g., MCP requests, Worker-to-daemon calls):

```typescript
export function requestContextFromHttpHeaders(
  headers: Record<string, string>
): TryRequestContextResult {
  const authHeader = headers['authorization'];
  const daemonToken = authHeader?.replace(/^Bearer\s+/, '');

  if (!daemonToken) {
    return {
      ok: false,
      error: new UnauthorizedRequestContextError(
        'Authorization header with Bearer token required for context-switching'
      )
    };
  }

  // Token present; packages/myco/src/grove/request-context.ts validates
  // it against daemon.json and extracts context from remaining headers.
}
```

### Silent Failure Prevention

**Critical Pattern**: Context-switching failures without authentication MUST NOT silently return null. Instead, return explicit authorization errors:

```typescript
// BAD: Silent failure (buffered to disk, never audited)
if (!authToken) return null;

// GOOD: Explicit error with diagnostics
if (!authToken) {
  throw new UnauthorizedRequestContextError(
    'Context-switching headers require Bearer token authentication'
  );
}
```

### Token Storage and Lifecycle

Daemon auth tokens are stored in `~/.myco/daemon.json` (machine-scoped). **Token Rotation**: Daemon auth tokens rotate on each daemon restart. On 401 responses, refresh the token by re-reading `~/.myco/daemon.json` and retry the request.

### Authorization Boundaries

Token verification establishes these boundaries:

1. **Machine Identity**: Token is machine-specific (tied to `daemon.json`). Cannot be transferred across machines.
2. **Daemon Identity**: Token verifies that the request came from an authorized daemon process, not a rogue client.
3. **Project Scope**: Once token is verified, `x-myco-project-id` determines project isolation in DB operations.

**Never treat a valid token as blanket authorization** — always scope subsequent DB operations by `project_id` from headers.

## Procedure E: Prevent Worktree-Bleed in New Code

When adding new filesystem operations:

1. **Apply the classification pattern immediately**:
   ```typescript
   // Instead of using a single root:
   const badPath = path.join(context.projectRoot, relativePath);

   // Classify the operation first:
   const root = needsCallerLocal
     ? filesystemRootFromRequestContext(context)
     : context.projectRoot;
   const goodPath = path.join(root, relativePath);
   ```

2. **Use audit anchors to verify classification**:
   - **Identity signals**: flows to `vaultDbPath`, `resolveProjectVaultDir`, `loadGroveRecord`, `resolveGroveDbPath`
   - **Caller-local signals**: flows to plan operations, file monitoring, config resolution, source discovery

3. **Test worktree scenarios explicitly**:
   - Verify operations work correctly from `.claude/worktrees/feature-branch/`
   - Ensure identity operations remain stable across worktree checkouts
   - Check that caller-local operations follow the user's working directory

4. **Document the root choice**:
   ```typescript
   // Identity: vault operations must not vary across worktrees
   const vaultPath = resolveProjectVaultDir(context.projectRoot);

   // Caller-local: plan operations must follow user's actual cwd
   const watchRoot = filesystemRootFromRequestContext(context);
   ```

## Cross-Cutting Gotchas

**Trust model mismatch**: `x-myco-caller-root` is free-form (matches what it represents) while `x-myco-project-root` has spoofing guards. Never feed caller root into registry lookups.

**Fallback behavior**: `callerRoot ?? projectRoot` preserves current behavior when no caller cwd is supplied, making the migration safe for existing code.

**Harness wiring gap**: Until agent harnesses populate `MYCO_CALLER_ROOT`, `callerRoot` will be null in practice. The structural fix handles this gracefully but full worktree support requires harness updates.

**Canopy identity vs locality**: Scanning and entry management stay identity-keyed to prevent row conflicts, while file path canonicalization follows caller locality. This distinction prevents worktree chaos in the canopy database.

**One-field decisions**: Future worktree issues become a single field choice (`callerRoot ?? projectRoot` vs `projectRoot`) instead of requiring architectural changes, enforced by the type system.

**Authorization header is mandatory for context-switching**: Requests that include `x-myco-project-root`, `x-myco-project-id`, or `x-myco-grove-id` MUST include a valid `Authorization: Bearer <token>` header. Missing or invalid tokens return 401, not null silently. This prevents unauthorized cross-project access and ensures all context-switching is auditable.

**Token validation timing**: Bearer token MUST be validated BEFORE any context headers are parsed or acted upon. Check token first, parse headers second. This prevents partially-processed unauthorized requests.

**No silent 401 buffering**: In Pi extensions and MCP clients, catching 401 responses and buffering them to disk for later retry is a debugging nightmare. Instead, fail fast with explicit error messages. Store tokens correctly at startup and refresh on daemon restart.

**Machine-scoped tokens cannot be shared**: Daemon auth tokens in `~/.myco/daemon.json` are tied to the machine's daemon process. Do not bake them into CI/CD configs or shared environments. Each machine needs its own daemon and token lifecycle.

**`buildVaultFallbackOrGlobal` is the internal fallback builder**: When explicit context headers are absent, `buildVaultFallbackOrGlobal` in `packages/myco/src/grove/request-context.ts` constructs a synthesized context from a vault directory. It is an internal function — do not call it from tool handlers or external code; use the exported `requestContextFromHttpHeaders` or CLI launch options instead.

**`rowProjectIdFromRequestContext` vs `requireProjectId` — choose deliberately**: Use `rowProjectIdFromRequestContext` only when project context is genuinely optional (e.g., a telemetry call that degrades gracefully with no project). Use `requireProjectId` everywhere a missing project would produce corrupt or misrouted data. The label argument appears in error messages, so make it descriptive.

**`tenantRoute` is the enforcement seam for all project-scoped routes**: New daemon routes that need project scope MUST be wrapped in `tenantRoute` (from `packages/myco/src/daemon/api/route-helpers.ts`). It resolves the principal and authorizes BEFORE the handler sees the request, then fails closed+loud on any violation — 400 response plus a visible `tenancy.violation` warning. A handler that bypasses `tenantRoute` silently receives the daemon's synthesized anchor context (which exists on every request by design), creating a cross-tenant leak instead of a visible auth failure.

**`launchContextTenancy: true` is required for CLI commands that need caller tenancy**: CLI entry points (e.g., `packages/myco/src/cli/search.ts`, `packages/myco/src/cli/tool.ts`) MUST pass `launchContextTenancy: true` in their launch options. Without it, TenancySource is set to `'synthesized'` instead of `'caller'`, and the context will fail the `resolvePrincipal`/`authorize` checks inside `tenantRoute`, producing 400 errors on routes that require proper tenancy.

**`projectScopeFromRequestContext` stays lenient by design**: This function returns `GLOBAL_SCOPE` when no project context is found and never throws. A previous attempt to make it fail at the seam level broke 399 tests and ~40 consumers that legitimately call it from optionally-scoped contexts. Enforcement is opt-in at the route level via `tenantRoute` — only routes that explicitly require project context are wrapped. Never make the seam-level function fail-closed.

**`use-git-identity` hook missing tenancy headers produces 404, not 400**: The `use-git-identity` hook doesn't attach tenancy headers, so `resolveScopedRoot` silently falls back to the non-git root. This produces a 404 (resource not found at fallback root) instead of the expected 400 (missing tenancy). Unexplained 404s from git-identity flows are a fingerprint of this tenancy-invariant violation — check tenancy header population in the hook invocation.

**`make dev-link-worktree` must not be run in isolated programmatic scenarios**: The `dev-link-worktree` Makefile target writes `.myco/runtime.command` and shares the same vault as the main checkout. Running it in programmatic or CI scenarios causes the shared vault's schema migrations to be driven by the worktree's binary version, which may be ahead of the main checkout. This can permanently migrate the shared vault to a schema version the main checkout cannot read. Use only in manual developer worktree setups where vault sharing is intentional and understood.
