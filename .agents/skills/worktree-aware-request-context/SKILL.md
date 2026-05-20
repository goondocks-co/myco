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

Myco's request context architecture separates project identity from caller locality through dual filesystem roots. This prevents worktree-bleed bugs where operations meant for the caller's actual working directory incorrectly use the canonical project root instead.

## Prerequisites

- Understanding of MycoRequestContext structure and flow
- Familiarity with Grove registration and project identity concepts
- Knowledge of worktree patterns and potential bleed scenarios
- Access to `packages/myco/src/tools/request-context.ts` and related request handling code

## Procedure A: Implement callerRoot vs projectRoot Separation

When designing or modifying request context handling:

1. **Preserve both roots in MycoRequestContext**:
   ```typescript
   interface MycoRequestContext {
     projectRoot: string;      // Canonical, registered project identity
     callerRoot: string | null; // Caller's actual cwd, preserved untouched
     projectId: string;        // Sole identity for DB operations
     // ... other fields
   }
   ```

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

## Procedure D: Prevent Worktree-Bleed in New Code

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