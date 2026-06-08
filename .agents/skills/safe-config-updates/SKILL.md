---
name: myco:safe-config-updates
description: "Apply this skill whenever you need to write, update, or modify Myco configuration — whether from a React settings form, a CLI command, a task, or any other code path. This covers the two linked invariants that prevent silent data loss: (1) all YAML writes must flow through updateConfig() in packages/myco/src/config/loader.ts, and (2) all React settings forms must spread the original config before overlaying form values in their formToConfig() function. Also covers the complete procedure for adding new configurable settings to Myco's three-tier scoped config system (machine/grove/project/personal) including scope assignment decisions, Zod schema extension, API endpoint integration, useScopedConfig hook wiring, and ScopedField component wrapping. Use this skill even if the user hasn't explicitly asked about config safety — any time you touch myco.yaml, add a settings field, modify a settings page, or add new configurable fields, these patterns apply."
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Safe Config Update Patterns

`myco.yaml` is a multi-section document owned by different UI pages and code paths. If any write path reconstructs the config from scratch rather than patching it, it silently drops keys it doesn't know about. This skill teaches the two-layer defense: a single YAML write gate in `packages/myco/src/config/loader.ts`, and a spread-before-overlay pattern in every React form. Additionally, Myco uses a three-tier scoped configuration model where machine-global settings live in `~/.myco/config.yaml`, grove-level settings live in `~/.myco/groves/<id>/grove.yaml`, project-team settings live in committed `myco.yaml`, while personal overrides live in gitignored `.myco/local.yaml`, enabling per-machine personalization and multi-project coordination without affecting team defaults.

## Prerequisites

- Understand that `myco.yaml` has independent sections (`vault`, `backup`, `embedding`, `tasks`, etc.) and no single UI page owns the whole file
- Know which section(s) your change targets
- For React form changes: locate the relevant settings page and its `formToConfig()` function
- For programmatic writes: locate `packages/myco/src/config/loader.ts` and `packages/myco/src/config/updates.ts`
- Understand the three-tier config hierarchy: machine (`~/.myco/config.yaml`) → grove (`~/.myco/groves/<id>/grove.yaml`) → project (`myco.yaml`) → personal (`.myco/local.yaml`)
- Know that config is deep-merged via `loadConfig()` with `arrayStrategy: 'replace'` where higher-tier (personal) values win
- Recognize that daemon subsystems can subscribe to config changes for live-reload without restart
- Understand Grove's global daemon architecture and how it coordinates settings across multiple projects
- Know that config tier migration preserves existing project configurations while enabling grove coordination

---

## YAML Writes — The Single Gate Rule

### Why one gate?

If two code paths independently serialize and write `myco.yaml`, they race and one will clobber the other's sections. Even without a race, any path that reconstructs the config from a partial view will lose keys it never read.

The solution: `updateConfig(vaultDir, fn)` in `packages/myco/src/config/loader.ts` is the **only** function that may write `myco.yaml`. It reads the current file, calls your mutation function `fn(config) => config`, and writes the result. This guarantees every write starts from the full current state.

### Steps

1. **Import the gate and helpers:**
   ```ts
   import { updateConfig } from '../config/loader';
   import { withValue, withEmbedding, withTaskConfig } from '../config/updates';
   ```

2. **Use a named helper when one exists.** `packages/myco/src/config/updates.ts` exports typed helpers for common mutations:
   ```ts
   // Set a single scalar value at a dotted path
   await updateConfig(vaultDir, withValue('backup.dir', newDir));

   // Update embedding config (preserves sibling keys)
   await updateConfig(vaultDir, withEmbedding({ model: 'text-embedding-3-small' }));

   // Update a task config block
   await updateConfig(vaultDir, withTaskConfig('intelligence', { provider: 'anthropic' }));
   ```

3. **For mutations not covered by a helper, write a targeted updater:**
   ```ts
   await updateConfig(vaultDir, (config) => ({
     ...config,
     backup: {
       ...config.backup,        // ← preserve sibling keys like backup.schedule
       dir: newDir,
     },
   }));
   ```
   The spread at every level is what makes partial updates safe. Without `...config.backup`, setting `backup.dir` would drop `backup.schedule` and any future keys.

4. **The only legitimate exception** is `init.ts` creating a brand-new vault where no existing file exists yet. Every other write path must use `updateConfig`.

### Grove-specific considerations

**Global daemon coordination**: Grove's global daemon architecture means config changes may need coordination across multiple project vaults. Use the appropriate grove-aware config loader when working in a multi-project context.

**Migration patterns**: Grove migration introduces new config layering where project-local configs can reference grove-global settings. Ensure config updates respect these layered dependencies and don't break grove coordination.

**Tier migration compatibility**: When implementing features that modify configuration across projects, ensure compatibility with config tier migration patterns. Project configurations should remain functional when migrated to grove coordination models.

### Pitfall: append-only gitignore staleness

`myco.yaml` contains a `gitignore` section with patterns that the daemon writes to `.gitignore`. This section is managed with a strip-and-rewrite strategy (the daemon removes the old Myco block and writes a fresh one), not with `updateConfig`. Don't conflate these: `.gitignore` writes are strip-and-rewrite, `myco.yaml` writes go through the gate.

---

## React Settings Forms — Spread Before Overlay

### Why spread?

A settings page only renders fields for its own section. When the user submits, `formToConfig()` reconstructs a config object from form state. If it builds from scratch, every key it doesn't render disappears on save — including keys owned by other pages, keys added by future features, and keys set programmatically.

The fix is structural: always start from the original config and overlay only what this page owns.

### Steps

1. **Accept the original config in `formToConfig()`:**
   ```ts
   // BAD — reconstructs from scratch, drops everything not in this form
   function formToConfig(values: FormValues): MycoConfig {
     return {
       vault: { path: values.vaultPath },
       backup: { dir: values.backupDir },
     };
   }

   // GOOD — starts from original, overlays only owned sections
   function formToConfig(values: FormValues, original: MycoConfig): MycoConfig {
     return {
       ...original,                          // preserve ALL sections
       backup: {
         ...original.backup,                 // preserve sibling keys within section
         dir: values.backupDir,
       },
     };
   }
   ```

2. **Pass the original config through to `formToConfig()`.** In the settings page component, the original config should come from the store or props:
   ```ts
   const handleSave = async (values: FormValues) => {
     const updated = formToConfig(values, originalConfig);
     await updateConfig(vaultDir, () => updated);
   };
   ```

3. **Remove sections a page doesn't own.** If a settings page previously included fields for a section now owned by a different page, remove those fields entirely — don't leave them as pass-through hidden inputs. Ownership should be exclusive and clear.

4. **`auto_run` requires a hot-reload signal.** If your form touches `vault.auto_run` or any field that controls daemon behavior, the daemon won't pick it up until it restarts or receives a reload event. The config write alone is not sufficient — ensure the save handler also sends the appropriate IPC signal.

### Pitfall: silent key dropping is invisible

Config data loss from the `formToConfig()` bug is silent at the UI layer — the save appears to succeed, but keys vanish from `myco.yaml`. The only way to notice is to inspect the YAML after saving. When adding a new settings field, always open `myco.yaml` after your first test save and verify unrelated sections are intact.

---

## Patch-Based Settings API — Modern Granular Updates

### Why patch endpoints?

The Settings UI uses dedicated PATCH handling via `handlePutScopedConfig` in `packages/myco/src/daemon/api/config.ts` that replaces the monolithic PUT pattern. This enables granular field-level updates without requiring clients to manage the full configuration object. The ScopedField React component automatically handles the patch semantics and scope resolution.

### Steps

1. **Use ScopedField components for settings UI:**
   ```tsx
   import { ScopedField } from '../components/ScopedField';

   // The component automatically handles patch-based updates
   <ScopedField
     path="embedding.model"
     scope="personal"
     label="Embedding Model"
   />
   ```

2. **ScopedField automatically patches via the scoped config handler:**
   - Personal-scoped settings → `handlePutScopedConfig`
   - Handles the patch semantics internally

3. **When building custom settings forms, use the scoped config endpoint directly:**
   ```ts
   // For personal/team scoped settings via handlePutScopedConfig
   await fetch('/api/config', {
     method: 'PUT',
     body: JSON.stringify({
       path: 'embedding.model',
       value: 'text-embedding-3-large',
       scope: 'personal'
     })
   });
   ```

4. **Legacy full-config PUT is deprecated.** New settings UI should use patch-based handling exclusively through the scoped config API.

### Benefits over monolithic updates

- **Eliminates config reconstruction bugs** — no need to manage the full config object in forms
- **Automatic scope resolution** — ScopedField handles personal vs team scope assignment
- **Field-level granularity** — only the specific setting being changed is updated
- **No spread-before-overlay complexity** — the patch semantics handle preservation automatically

---

## Scoped Config Architecture — Three-Tier System

### Understanding the three-tier scoped config model

Myco's three-tier scoped configuration enables machine-global defaults, grove-level coordination, project team settings, and per-machine personalization:

- **Machine tier** (`~/.myco/config.yaml`) — global daemon configuration across all groves and projects
- **Grove tier** (`~/.myco/groves/<id>/grove.yaml`) — grove-level settings that coordinate across multiple projects within a grove  
- **Project tier** (`myco.yaml`) — committed team-shared settings that affect how the team collaborates
- **Personal tier** (`.myco/local.yaml`) — gitignored per-machine overrides for individual developer preferences

The daemon uses `loadMergedConfig()` which calls `pruneToTier(raw, tier)` for each tier before merging. `pruneToTier` is the **primary enforcement mechanism** — it uses `SCOPE_REGISTRY` from `packages/myco/src/config/scope.ts` to keep only leaf paths whose `home` or `overridableBy` tiers allow them. Deep-merge follows with `arrayStrategy: 'replace'` where higher-tier (personal) values win.

### Grove architecture coordination patterns

**Multi-project coordination**: Grove's global daemon architecture introduces additional configuration layers for coordinating settings across multiple project vaults within a grove. The global daemon maintains grove-level configuration that provides defaults for project-level settings.

**Migration compatibility**: Grove migration procedures can update existing project configurations to reference grove-global settings where appropriate, maintaining backward compatibility while enabling grove-wide coordination.

**Initialization patterns**: Grove-aware init procedures detect and integrate with existing project configurations, ensuring smooth onboarding without disrupting established project settings.

**Config tier migration patterns**: When migrating configurations to grove coordination, preserve existing project config semantics while adding grove-level defaults. Ensure that migrated configurations maintain the same effective behavior for teams that don't use grove features.

### Classify New Config Settings by Tier

When adding any new user-configurable behavior, follow these steps to determine which tier it belongs in:

**Step 1: Apply the tier decision rule**
- **Machine tier**: Global daemon behavior across all groves (port, logging, global auth)
- **Grove tier**: Multi-project coordination within a grove (shared resources, grove-wide policies, agent provider and model selection, agent harness configuration, task configuration overlays, embedding configuration)  
- **Project tier**: Team collaboration settings specific to this project (task configs, team sync)
- **Personal tier**: Individual developer experience preferences (UI themes, notification settings, daemon operational settings)

**Step 2: Consult the scope registry**
The canonical tier assignment for every config field lives in `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts`. This registry is the single source of truth — it drives `pruneToTier()` enforcement during config loading and the UI scope indicators. Look up the closest parent path in the registry to find precedent for similar fields.

Use these established patterns as representative examples (verify against the live registry for current state):

*Personal Settings:* Per-machine preferences that do not affect team collaboration
- Daemon operational settings (`daemon.port`, `daemon.log_level`)
- UI personalization (`appearance.theme`, `appearance.font_size`, `appearance.dark_mode`, `appearance.density`)
- Notification preferences (`notifications.*`)
- Maintenance automation (`maintenance.auto_optimize`)

*Project Settings:* Shared team configuration affecting workflow behavior
- Symbiont manifest (`symbionts.*`)
- Agent operational limits (`agent.timeout`, `agent.context_window`)
- Vault data policies (`vault.retention_days`, `vault.max_sessions`)
- Team sync enablement (`sync.enabled`)

*Grove Settings:* Multi-project coordination within a grove
- Agent provider and model selection (`agent.provider`, `agent.model`)
- Agent harness configuration (`agent.harness`)
- Task configuration overlays (`agent.tasks.*`)
- Embedding provider configuration (`embedding.provider`)

*Machine Settings:* Global daemon configuration  
- Global daemon port and networking
- Machine-level authentication
- Global logging and diagnostics

**Step 3: Add the field to SCOPE_REGISTRY and the Zod schema**
New fields must be registered in `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts` with the correct `home` tier and `overridableBy` array. The scope-registry sync test will fail if a schema leaf is not covered, so ratify against the Zod tier schemas in `packages/myco/src/config/schema.ts`.

**Step 4: Document your decision**
Add the new field to the appropriate tier in comments and update any scope defaults matrices in the UI layer.

### Handle Legacy Config Fields During Tier Migration

When architectural changes move fields between tiers, two mechanisms cooperate:

**Primary enforcement — `pruneToTier()`**: The loader calls `pruneToTier(raw, tier)` for every tier in `loadMergedConfig`. This uses `SCOPE_REGISTRY` to silently drop any fields that don't belong to the given tier — so once a field's `home` tier is updated in the registry, misplaced values in other tiers are automatically ignored at load time.

**Legacy strip — `PROJECT_TIER_LEGACY_FIELDS`**: For fields that historically lived in the wrong tier and need to be actively removed from committed `myco.yaml` files (not just ignored), add them to `PROJECT_TIER_LEGACY_FIELDS` in `packages/myco/src/config/schema.ts`. The loader's `stripLegacyProjectFields()` function iterates this list and calls `unsetAtPath()` to physically remove them from the YAML document, preventing stale fields from cluttering project configs.

**When to use each:**
- New field at correct tier from day one → just add to `SCOPE_REGISTRY`; `pruneToTier` enforces it automatically
- Field moved from project → grove tier → add to `SCOPE_REGISTRY` with new home; also add to `PROJECT_TIER_LEGACY_FIELDS` so the old project-tier value gets stripped from `myco.yaml` on next load
- Field removed entirely → add to `PROJECT_TIER_LEGACY_FIELDS` to clean up existing configs; no registry entry needed

This silent-strip pattern ensures that when developers pull code with a tier reorganization, old fields in `myco.yaml` do not interfere with new grove-tier values, preventing silent shadowing of grove defaults.

### Two-Layer Config Migration Procedures

When migrating existing projects to a new config architecture, use a two-layer approach:

**Layer 1: Client-side silent strip**
The client removes legacy fields during `loadConfig()` before merging via `stripLegacyProjectFields()`. This protects against old project-tier fields shadowing new grove-tier defaults.

**Layer 2: Daemon-side reconciliation**
On next daemon startup after the migration-aware code is deployed, the daemon detects legacy fields in `myco.yaml` and offers a migration guide. This allows teams to understand what changed without breaking existing setups.

Use `loadMergedConfig(vaultDir, { groveId })` to automatically resolve grove-tier settings via the specified grove ID, integrating grove defaults into the final merged config.

### Add New Scoped Config Fields

**Step 1: Update the config schema**
Add the new field to the appropriate section in `packages/myco/src/config/schema.ts`:

```typescript
// For Personal-scoped field - add to the appropriate schema
const DaemonSchema = z.object({
  // existing fields...
  new_personal_field: z.string().default("defaultValue"),
});

// For Grove-scoped field - add to the appropriate schema
const GroveConfigSchema = z.object({
  // existing fields...
  new_grove_field: z.boolean().default(false),
});

// For Project-scoped field - add to the appropriate schema
const TasksSchema = z.object({
  // existing fields...
  new_project_field: z.boolean().default(false),
});
```

**Step 2: Register the field in SCOPE_REGISTRY**
Add the new field to `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts` with correct `home` and `overridableBy`:

```typescript
// In scope.ts SCOPE_REGISTRY
'your.new.field': { home: 'grove', overridableBy: ['local'] },
```

The scope-registry sync test will fail if this entry is missing, so add it before running tests.

**Step 3: Verify the scoped config endpoint handles your field**
The endpoint at `packages/myco/src/daemon/api/config.ts` handles partial patch merging with validation via `handlePutScopedConfig`:

```typescript
// Endpoint contract: { scope: 'project' | 'local', patch: {...}, clear?: [...] }
// patch_clear_overlap validation prevents same key in both patch and clear arrays
```

Your new field should automatically work through this endpoint once added to the schema.

**Step 4: Add field to scope defaults matrix (for UI)**
If your field will appear in the daemon UI, update the scope defaults in the appropriate Settings component:

```typescript
// In settings UI component
const scopeDefaults = {
  'existing.field': 'local' as const,
  'new.personal.field': 'local' as const,
  'new.grove.field': 'project' as const,
  'new.project.field': 'project' as const,
};
```

**Step 5: Handle restart-required fields (if applicable)**
If the field requires daemon restart rather than live-reload, add it to the restart-required pattern in the UI:

```typescript
const RESTART_REQUIRED_PATHS = [
  'daemon.port',
  'daemon.log_level',
  'new_field_requiring_restart'
];
```

---

## Config-Change Reactions — Live Reload System

Use `registry.on(pathPrefixes, handler)` from the ConfigReactionRegistry to subscribe daemon subsystems to config changes for live-reload.

### Set Up Config-Change Reactions

**Step 1: Get access to the registry**
In the subsystem initialization code, obtain the ConfigReactionRegistry instance:

```typescript
import type { ConfigReactionRegistry } from '../config-reactions/registry.js';

// Registry is typically passed as a dependency during daemon startup
function initializeSubsystem(registry: ConfigReactionRegistry, deps: Dependencies) {
  // Register reactions here
}
```

**Step 2: Register the reaction**
```typescript
// Path-prefix semantics: array of strings, prefix match triggers
// Empty array [] fires on every config write
registry.on(['agent.model', 'embedding'], createModelReaction(dependencies));
```

**Step 3: Implement closure factory pattern**
Create reactions using the standard closure factory:

```typescript
// Dependencies explicit at call site, testable in isolation
function createModelReaction(deps: { logger: Logger, embedManager: EmbedManager }) {
  return (config: MycoConfig) => {
    // Handler must be idempotent - no self-writes
    // Use the provided config object (already parsed, optimized)

    deps.logger.info('Model config changed, updating embedding provider');
    deps.embedManager.updateProvider(config.embedding.provider);
  };
}
```

**Step 4: Follow idempotency constraints**
Reactions must be idempotent and cannot trigger self-writes that would create feedback loops. If a reaction needs to write config, it should do so through a separate mechanism outside the reaction system.

---

## Config Toggle Side-Effects — File Mutation Patterns

For `myco.yaml` boolean toggles requiring file mutations (like symbiont installation), use the established pattern:

### Implement Config Toggle Side-Effects

**Step 1: Single opt-in flag in schema**
```typescript
const ConfigSchema = z.object({
  enable_new_feature: z.boolean().default(false),
});
```

**Step 2: Static managed block**
Insert managed blocks on `myco init` and reconcile on `myco update`:
```bash
# Generated by myco - do not edit directly
# myco:feature-block:start
generated content here
# myco:feature-block:end
```

**Step 3: In-process reconciliation**
Trigger reconciliation via SymbiontInstaller after config save - NOT CLI subprocess:

```typescript
// In config write handler
if (newConfig.enable_new_feature !== oldConfig.enable_new_feature) {
  await SymbiontInstaller.reconcileFeatureBlocks();
}
```

This pattern keeps side-effects deterministic and avoids the complexity of subprocess coordination.

---

## Cross-Cutting Gotchas

**Silent key dropping is invisible:** Config data loss from the `formToConfig()` bug is silent at the UI layer — the save appears to succeed, but keys vanish from `myco.yaml`. The only way to notice is to inspect the YAML after saving. When adding a new settings field, always open `myco.yaml` after your first test save and verify unrelated sections are intact.

**Local config path construction:** In `localConfigPath()`, `vaultDir` already includes `.myco`, so use `path.join(vaultDir, LOCAL_CONFIG_FILENAME)` directly. Don't prepend `.myco/` again or you'll get `.myco/.myco/local.yaml` double-nesting.

**Path-prefix subscription semantics:** `registry.on(['agent'])` triggers for `agent.model`, `agent.provider`, `agent.timeout`, etc. Use specific paths like `['agent.model']` if you only care about model changes.

**Merge strategy implications:** `arrayStrategy: 'replace'` in `deepMergeConfig()` means local arrays completely replace project arrays. For additive behavior, use object merging instead of arrays.

**Scope pill UX pattern:** The UI uses per-field scope indicators (Personal/Project pills) rather than section-level grouping. This supports mixed-scope forms and field-level override visibility.

**Registry vs. direct config reads:** Use the `config` parameter passed to reactions for performance. The registry has already paid the YAML + schema parse cost once. Only call `loadConfig()` separately if you need to detect concurrent changes during reaction processing, which is rare.

**Grove migration config compatibility:** When working with grove-aware configurations, ensure backward compatibility with pre-grove project configs. Grove migration procedures should preserve existing project settings while enabling grove coordination.

**Multi-project configuration isolation:** Grove's global daemon coordinates multiple projects, but config changes should maintain appropriate isolation between projects unless explicitly designed for grove-wide coordination.

**Three-tier merge precedence:** Remember that personal overrides win over project settings, which win over grove settings, which win over machine defaults. When debugging config issues, check all four tiers in the merge chain.

**Grove-tier scope selection:** When adding grove-level settings, ensure they truly coordinate across projects rather than duplicating project-level functionality. Grove settings should enable multi-project workflows, not replace project autonomy.

**Config tier migration false positives:** During drift analysis, config property paths like `myco.yaml` and `backup.dir` are configuration property references, not missing file paths. Verify that core config safety functions remain present in the loader module before assuming drift.

**Legacy field shadowing:** When adding to PROJECT_TIER_LEGACY_FIELDS for migration, ensure the strip happens at load time before tier merging. If a legacy project-tier `agent.provider` exists alongside a new grove-tier `agent.provider`, the legacy field will shadow the grove value until it's stripped.

**SCOPE_REGISTRY sync test:** A scope-registry sync test enforces that every Zod schema leaf has a registry entry. After adding a new config field to the schema, always add it to `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts` — or the test will fail loudly.

**loadMergedConfig groveId resolution:** `loadMergedConfig(vaultDir, { groveId })` automatically resolves and merges grove-tier configuration from `~/.myco/groves/<groveId>/grove.yaml` when groveId is provided. When groveId is not provided, it auto-resolves from `loadProjectManifest(vaultDir)` to detect the project's grove association. If groveId is undefined and the project manifest contains no grove association, grove-tier settings are skipped.

**Scoped-clear pruneEmptyParents omission:** When writing `unsetAtPath()` calls in a scoped-clear loop (e.g., `for (const key of clearList) unsetAtPath(working, key)`), always pass `{ pruneEmptyParents: true }`. Without it, deleting the last leaf under a parent key leaves an empty-map object as residue in the persisted YAML instead of removing the parent entirely. Both clear loops in `handlePutScopedConfig` (`packages/myco/src/daemon/api/config.ts` lines ~168 and ~201) currently omit this option — include it when implementing any new scoped-clear logic.

---

## Checklist Before Submitting a Config Change

- [ ] YAML write goes through `updateConfig()` (or a named helper that uses it)
- [ ] Every partial update spreads sibling keys at each level
- [ ] `formToConfig()` accepts and spreads the original config (legacy forms only)
- [ ] Settings page only sets fields it owns — no pass-through of other pages' sections
- [ ] Modern settings UI uses ScopedField components or patch endpoints directly
- [ ] If touching daemon-behavior fields, reload signal is sent
- [ ] New scoped config fields added to both Zod schema AND `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts`
- [ ] Config reactions follow closure factory pattern and idempotency constraints
- [ ] Config toggle side-effects use managed blocks and in-process reconciliation
- [ ] Grove architecture compatibility considered for multi-project coordination
- [ ] Three-tier merge precedence understood and documented
- [ ] Config tier migration compatibility verified for grove coordination features
- [ ] Legacy field handling: use `PROJECT_TIER_LEGACY_FIELDS` in schema.ts for fields that need physical removal from project YAML; `pruneToTier` auto-enforces scope for everything else
- [ ] Scoped-clear operations pass `{ pruneEmptyParents: true }` to `unsetAtPath()` to avoid empty-map residue
- [ ] Manual verification: inspect `myco.yaml` after a test save to confirm no data loss
