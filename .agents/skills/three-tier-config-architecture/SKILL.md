---
name: myco:three-tier-config-architecture
description: Comprehensive procedures for implementing and managing Myco's three-tier configuration architecture with Machine/Grove/Project scope hierarchy. Covers config storage design with scope enforcement patterns, TypeScript compile-time scope validation, multi-tier settings UI development, hierarchical config merging and override resolution strategies, and migration workflows for scope boundary evolution. Use this when implementing new configuration settings, refactoring config scope boundaries, building scope-aware editing interfaces, or migrating configuration data between tiers, even if the user doesn't explicitly ask for three-tier architecture guidance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Three-Tier Configuration Architecture and Management

Myco's configuration system implements a three-tier hierarchy: Machine (global), Grove (shared across projects), and Project (local overrides). This architecture enables flexible configuration management with clear scope boundaries and inheritance patterns, now enhanced with portable project identity via `.myco/project.toml`.

## Prerequisites

- Understanding of Myco's Machine/Grove/Project identity model with portable project.toml
- Familiarity with TypeScript type system for compile-time validation
- Access to the codebase at `packages/myco/src/config/` and `packages/myco/ui/src/pages/`
- Knowledge of the settings schema format and validation patterns
- Understanding of Grove identity architecture and binding_id patterns

## Procedure A: Implementing Three-Tier Config Storage Design

### 1. Understand the Flat-Function API

All config I/O flows through flat functions in `packages/myco/src/config/loader.ts`. There are no storage classes — use the exported functions directly:

```typescript
// packages/myco/src/config/loader.ts — read functions
loadMachineConfig()               // reads ~/.myco/config.yaml
loadGroveConfig()                 // reads the grove-level config.yaml
loadLocalConfig(vaultDir)         // reads .myco/local.yaml (personal, not committed)
loadConfig(filePath)              // reads any config file by absolute path
loadMergedConfig({ projectPath }) // reads all tiers, returns merged result

// packages/myco/src/config/loader.ts — write functions
updateConfig(filePath, partial)      // deep-merge update of any config file
updateGroveConfig(partial)           // partial update of grove config
saveGroveConfig(fullConfig)          // full replacement of grove config
saveLocalConfig(vaultDir, config)    // full replacement of local config

// Example
const machineConfig = loadMachineConfig();
const groveConfig = loadGroveConfig();
const { config } = await loadMergedConfig({ projectPath });
await updateGroveConfig({ embedding: { provider: 'openai' } });
```

### 2. Scope Enforcement via SCOPE_REGISTRY

The `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts` is the single source of truth for which tier owns each field. `pruneToTier(raw, tier)` silently drops any fields that tier is not authorized to contribute:

```typescript
// packages/myco/src/config/scope.ts
scopePolicyForPath('embedding.provider')
// → { home: 'grove', overridableBy: [] }   (grove-locked)

scopePolicyForPath('agent.provider')
// → { home: 'grove', overridableBy: ['local'] }

tierAllowsPath('project', 'embedding.provider')  // false — grove-scoped
tierAllowsPath('grove',   'embedding.provider')  // true

// pruneToTier strips fields that don't belong to that tier
const cleanProject = pruneToTier(rawProjectDoc, 'project');
// grove-scoped keys in rawProjectDoc are silently removed
```

### 3. Portable Project Identity

Project-scoped configuration uses the stable identity from `.myco/project.toml`. The `binding_id` in that file persists across machine boundaries and clone operations. Load it via `loadProjectManifest` in `packages/myco/src/config/project-manifest.ts`:

```typescript
// packages/myco/src/config/project-manifest.ts
const manifest = await loadProjectManifest(projectPath);
// manifest.binding_id — stable UUID for this project across machines
// manifest.grove_id  — which Grove this project is bound to
```

## Procedure B: Type-Level Scope Enforcement and Compile-Time Safety

### 1. Use Tier-Specific Zod Schemas

Each tier has a dedicated Zod schema in `packages/myco/src/config/schema.ts` that only accepts fields valid for that tier. Parse raw YAML through the correct schema to get type safety:

```typescript
// packages/myco/src/config/schema.ts
MachineConfigSchema.parse(rawMachineDoc)   // typed as MachineConfig
GroveConfigSchema.parse(rawGroveDoc)       // typed as GroveConfig
ProjectConfigSchema.parse(rawProjectDoc)   // typed as ProjectConfig
// Zod throws ZodError if fields from wrong tiers are present
```

### 2. Enforce Scope at Write Call Sites

Use `scopePolicyForPath` and `tierAllowsPath` from `packages/myco/src/config/scope.ts` to guard writes before they reach the filesystem:

```typescript
// packages/myco/src/config/scope.ts
if (!tierAllowsPath('project', fieldPath)) {
  const policy = scopePolicyForPath(fieldPath);
  throw new Error(
    `${fieldPath} belongs to ${policy.home} tier; cannot write to project`
  );
}
```

### 3. Tier Precedence

The canonical tier ordering is exported from `packages/myco/src/config/scope.ts`:

```typescript
// TIER_PRECEDENCE = ['machine', 'grove', 'project', 'local']
// Higher index = higher precedence; local wins over all others.
```

## Procedure C: Settings UI Patterns for Multi-Tier Editing

### 1. Use useScopedConfig and ScopedField

The React settings UI provides two primitives for scope-aware forms, used throughout `packages/myco/ui/src/pages/`:

```typescript
// packages/myco/ui/src/hooks/use-scoped-config.ts
const { effective, isLoading } = useScopedConfig();
// `effective` is the fully merged config value across all tiers

// packages/myco/ui/src/components/config/ScopedField.tsx
<ScopedField>
  {/* field inputs that read from `effective`
      and write via updateGroveConfig() or updateConfig() */}
</ScopedField>
```

See `packages/myco/ui/src/pages/Cortex.tsx` for a worked example of `useScopedConfig` + `ScopedField` used together in a real settings page.

### 2. Design Inheritance Visualization

When building UI that shows override relationships, represent the full tier stack. Each setting has a `home` tier (the default) and optional `overridableBy` tiers. Use `scopePolicyForPath(fieldPath)` to determine the badge shown next to each field. Active overrides — when a higher-precedence tier has a value — should visually indicate which tier is "winning" so users understand why the effective value differs from the home-tier default.

## Procedure D: Config Merging and Override Resolution

### 1. The Four-Stage Merge Pipeline

Config merging in `loadMergedConfig()` applies tiers in ascending precedence order. Each stage uses `pruneToTier` to strip unauthorized fields before merging:

```typescript
// Actual merge pipeline — packages/myco/src/config/loader.ts
// machine < grove < project < local (each stage wins over the previous)
const stage1 = deepMergeConfig(pruneToTier(machineRaw, 'machine'), pruneToTier(groveRaw, 'grove'));
const stage2 = deepMergeConfig(stage1, pruneToTier(projectRaw, 'project'));
const merged  = deepMergeConfig(stage2, pruneToTier(localRaw, 'local'));
// Grove fields in a project yaml are silently dropped by pruneToTier();
// project fields in a grove yaml are silently dropped; etc.
```

### 2. Conflict Resolution

`deepMergeConfig` uses **replace semantics for arrays** (source arrays overwrite target arrays) and deep-merge for objects. There is no conflict-resolution negotiation — the later stage always wins for any key that appears in both. If different projects need different values for the same grove-locked field, the field is not suitable for grove tier; move it to project scope in `SCOPE_REGISTRY`.

## Procedure E: Migration Patterns for Scope Boundary Changes

### 1. Promote-Before-Strip Pattern: Two-Layer Automatic Migration Model

Myco uses a **promote-before-strip** two-layer automatic migration model for scope boundary evolution. Legacy fields are promoted (recognized) before being stripped (removed), ensuring zero data loss during migrations.

**Layer 1: PROJECT_TIER_LEGACY_FIELDS and GROVE_PROMOTED_FIELDS**

`PROJECT_TIER_LEGACY_FIELDS` in `packages/myco/src/config/schema.ts` lists the dot-path segments of all fields that have been moved out of project tier. The internal `stripLegacyProjectFields` helper in `packages/myco/src/config/loader.ts` reads this list and silently removes those fields when writing project config. When `loadMergedConfig()` encounters them, `pruneToTier(..., 'project')` drops them — they are not included in the merged result:

```typescript
// packages/myco/src/config/schema.ts
export const PROJECT_TIER_LEGACY_FIELDS: ReadonlyArray<readonly string[]> = [
  // fields moved to grove tier:
  ['embedding', 'run_in_deep_sleep'],
  ['agent', 'scheduled_tasks_active_window_days'],
  ['appearance'],
  // ... and others, including all of GROVE_PROMOTED_FIELDS via spread
];
// pruneToTier(projectRaw, 'project') drops all of these automatically.
```

`GROVE_PROMOTED_FIELDS` (also exported from `packages/myco/src/config/schema.ts`) is the companion subset listing fields that belong specifically to Grove tier — embedding settings, agent provider, harness, model, and scheduling fields. See the array definition in schema.ts for the current list. This array is spread into `PROJECT_TIER_LEGACY_FIELDS`, but with a **critical conditional**: `stripLegacyProjectFields()` only strips `GROVE_PROMOTED_FIELDS` entries when the project is Grove-bound (`hasGrove: true`). If the project has no Grove yet, these values are retained in the project config so they aren't silently lost. Once a Grove is bound, the values are available to migrate. Fields in `PROJECT_TIER_LEGACY_FIELDS` that are NOT in `GROVE_PROMOTED_FIELDS` (machine/personal tier moves) are always stripped unconditionally.

**Layer 2: Atomic `myco update` Lift**

Running `myco update` performs an atomic, value-preserving migration: legacy project-tier fields are lifted to Grove tier via `updateGroveConfig()` / `saveGroveConfig()`, and then the legacy fields are stripped from the project yaml. The exported `migrateLegacyLocalAppearanceToGrove` function in `packages/myco/src/config/loader.ts` is one example of this pattern — it moves appearance settings from local/project config into the Grove tier.

**Key properties of the promote-before-strip model:**

1. **Preservation**: Configuration VALUES are preserved during migration — they move from project to Grove tier, they are never lost or stripped
2. **Atomicity**: The `myco update` operation is atomic — either all projects migrate successfully or none do
3. **Conflict detection**: If different projects have different values for the same field, the Grove tier value takes precedence (with warning logged)
4. **Legacy recognition**: Existing code using `loadMergedConfig()` automatically skips legacy fields without errors
5. **Idempotency**: Running `myco update` multiple times is safe and idempotent — subsequent runs find no legacy fields and exit cleanly

### 2. Design Scope Migration Workflows

When moving a field from one tier to another:

1. Add the old path to `PROJECT_TIER_LEGACY_FIELDS` (or `GROVE_PROMOTED_FIELDS` if it's a Grove-tier field) so the promote-before-strip mechanism recognizes it
2. Update `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts` to assign the new home tier and `overridableBy` list
3. Add the new path to the appropriate tier Zod schema in `packages/myco/src/config/schema.ts`
4. Write a migration function that reads legacy values and writes them to the new tier via `updateGroveConfig()` / `updateConfig()` / `saveMachineConfig()`
5. Call the migration function from the `myco update` CLI path so it runs automatically on upgrade

### 3. Maintain Backward Compatibility During Migration

During the transition window, code must be able to read from both the old and new locations. Use `loadMergedConfig()` — it reads all tiers and applies precedence — so code that reads from the merged result automatically picks up values from whichever tier they currently live in. Avoid reading individual tier files directly during migration windows; always go through `loadMergedConfig()`.

### 4. Migration Validation

Before running a scope boundary migration in production:

- Verify all projects in the Grove have consistent values for the field being moved. Manually diff project configs or add a pre-flight check to the migration function.
- If projects disagree, determine whether the field should remain project-scoped. Grove-tier migration is appropriate only when the value should be consistent across all projects in a Grove.
- After migration, run `loadMergedConfig()` for each affected project and confirm the effective value matches the pre-migration value.
- Check `PROJECT_TIER_LEGACY_FIELDS` is updated so the old path is stripped on next write; otherwise stale entries persist.

## Cross-Cutting Gotchas

- **Context validation**: Always validate that the current context provides sufficient scope for the requested setting. Missing grove or project context will cause runtime errors when accessing grove/project-scoped settings.

- **Schema evolution**: When adding new settings, choose the scope carefully. Moving settings between scopes later requires complex migration procedures. Start with the narrowest appropriate scope (project) and broaden if needed.

- **Type safety boundaries**: TypeScript compile-time safety comes from the tier-specific Zod schemas (`MachineConfigSchema`, `GroveConfigSchema`, `ProjectConfigSchema`) in `packages/myco/src/config/schema.ts` and runtime enforcement via `scopePolicyForPath`/`tierAllowsPath` in `packages/myco/src/config/scope.ts`. Direct YAML manipulation bypasses all scope enforcement. Always use `updateConfig`/`updateGroveConfig`/`saveMachineConfig` and parse through the correct schema.

- **UI state synchronization**: Multi-tier settings interfaces can show stale data if not properly synchronized. Use reactive patterns or explicit refresh after scope changes to keep UI consistent with actual config state.

- **Migration atomicity**: Scope migrations are multi-step operations that can fail partway through. Always create rollback plans and validate migration steps before execution. Test migrations on non-production data first.

- **Config loader integration**: Always use `loadConfig()` and `updateConfig()` from `packages/myco/src/config/loader.ts` rather than direct file I/O. These functions handle the merging semantics and validation that make the three-tier system work correctly.

- **Portable project identity consistency**: Always use `binding_id` from `.myco/project.toml` for project-scoped configuration rather than derived identifiers. The binding_id is stable across machine boundaries and clone operations.

- **Project.toml dependency**: Project-scoped configuration access requires a valid `.myco/project.toml` file. Always validate project.toml presence and binding_id format before attempting project configuration operations.

- **Promote-before-strip pattern**: The two-layer automatic migration model PROMOTES (recognizes) legacy project-tier fields in Layer 1 before STRIPPING (removing) them in Layer 2. This ensures zero data loss. Never skip the promotion phase or attempt direct removal without atomic lift validation.

- **GROVE_PROMOTED_FIELDS conditional stripping**: Fields in `GROVE_PROMOTED_FIELDS` (the Grove-tier subset of `PROJECT_TIER_LEGACY_FIELDS`) are only stripped from project config when the project is Grove-bound. An unbound project retains these values so they survive until a Grove is available to receive them. Do not manually strip these fields from the project config without first ensuring the values are captured in Grove config.

- **Legacy project ID migration**: When migrating from legacy project identifiers, preserve configuration continuity by mapping legacy values to binding_id-based storage before removing legacy entries.

- **Grove identity coordination**: Project configuration changes may affect Grove-level settings inheritance. Always consider the Grove/project relationship when modifying project-scoped configuration patterns. Changes at Grove tier affect all projects unless overridden at project scope.

- **No-Grove-context in project-scope-only operations**: When operating on project-scoped configuration without Grove context, ensure you don't try to read or write Grove-tier fields. Project scope has a flat hierarchy — no inheritance from Grove layer without explicit context passing.

- **Automatic migration semantics**: The `myco update` command performs a TWO-LAYER automatic migration for scope boundary changes: (1) legacy project-tier fields are silently recognized but not used, (2) the atomic update operation lifts those values to Grove tier. Legacy fields are PRESERVED and MIGRATED, never stripped or lost. Running `myco update` multiple times is safe and idempotent.

- **Legacy field recognition during merge**: When `loadMergedConfig()` encounters legacy project-tier fields like `['embedding', 'run_in_deep_sleep']` or `['agent', 'scheduled_tasks_active_window_days']`, they are silently dropped by `pruneToTier(..., 'project')` and not included in the merged configuration. The system reads from Grove tier instead. This allows old code to continue working without changes while the two-layer migration runs in the background.

- **Scope boundary change coordination**: Before moving a configuration field from project to Grove tier, verify that all projects in the Grove will tolerate the same value. Different projects requiring different values for the same field indicates the field should remain project-scoped. Grove-tier migration is appropriate only when field values should be consistent across all projects in a Grove.

- **Atomic update failure recovery**: If `myco update` fails partway through the migration, Grove config may have been partially updated. Always check Grove and project config consistency after a failed update and re-run `myco update` to complete the migration.

- **Cross-Grove project configuration**: When projects span multiple Groves or migrate between Groves, ensure portable project identity (binding_id) remains stable. Configuration access must use the current Grove context to resolve appropriate Grove-tier overrides.

- **No-Grove gotcha — project-scope-only read paths**: Code paths that read project-scoped configuration without Grove context cannot access Grove-tier settings. This is intentional for security. If you need Grove settings in a project-only context, pass Grove context explicitly or redesignate the setting as project-scoped.

- **liveConfig is not per-grove**: In `packages/myco/src/daemon/power-jobs.ts`, `liveConfig` is typed as `{ current: MycoConfig }` — a mutable container holding the daemon's boot-grove merged config. It updates on config-change events but is NOT per-project. When daemon jobs iterate multiple groves or projects, always call `loadMergedConfig({ projectPath })` for each project to get the correct grove-specific merged config. Reading from the shared `liveConfig` container in a multi-grove iteration applies the boot grove's config to all other projects — a pattern confirmed to cause production failures where backup operations resolved to the wrong grove, causing a successful "Backup Now" to appear absent on the next read.

- **YAMLParseError on config write returns 422, not 500**: Any `YAMLParseError` surfaced during a config tier write is caught as `TierConfigUnreadableError` (exported from `packages/myco/src/config/loader.ts`) and mapped to a `422 tier_config_unreadable` HTTP response — never a 500. This guard covers both read-path and write-path operations (local-tier and grove-tier writes included). The response body is `{ error: 'tier_config_unreadable', message: '...', file: '<path>' }`. When authoring new config write handlers, always catch `TierConfigUnreadableError` explicitly and return 422 — do not let it fall through to the generic 500 error handler.

- **Scope mislabeling: machine-scoped settings silently ignored when written to wrong tier.** Fields with `home: 'machine'` in the `SCOPE_REGISTRY` (such as `daemon.update_channel` and other daemon configuration keys) are silently stripped by `pruneToTier()` if they appear in a grove or project config file. The write succeeds at the filesystem level but the value has zero effect — `loadMergedConfig()` never reads machine-tier fields from grove or project documents. There is no error or warning. Always call `scopePolicyForPath(fieldPath)` to check the home tier before writing, and use the tier-appropriate function: `saveMachineConfig` / `updateConfig` for machine-tier files, not `updateGroveConfig`.

- **Machine config is per-MYCO_HOME, not global.** `loadMachineConfig(mycoHome)` reads `{mycoHome}/config.yaml`. In daemon coexistence, the prod daemon (`MYCO_HOME=~/.myco`) and the dev/dogfood daemon (`MYCO_HOME=~/.myco-dev`) each have their own machine-tier config at separate paths. Writing `daemon.update_channel: manual` to the prod home's config affects only the prod daemon; the dev daemon's machine config is at the dev home. CLI code that calls `loadMachineConfig()` without an explicit `mycoHome` argument defaults to `resolveMycoHome()`, which reads `MYCO_HOME` from the environment — so the target config varies by which daemon is running. Always pass the target home explicitly in multi-home contexts.
