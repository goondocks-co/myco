---
name: myco:safe-config-updates
description: |
  Apply this skill whenever you need to write, update, or modify Myco configuration — whether from a React settings form, a CLI command, a task, or any other code path. This covers the two linked invariants that prevent silent data loss: (1) all YAML writes must flow through `updateConfig()` in `src/config/loader.ts`, and (2) all React settings forms must spread the original config before overlaying form values in their `formToConfig()` function. Also covers the complete procedure for adding new configurable settings to Myco's two-tier scoped config system including scope assignment decisions, Zod schema extension, API endpoint integration, useScopedConfig hook wiring, and ScopedField component wrapping. Use this skill even if the user hasn't explicitly asked about config safety — any time you touch `myco.yaml`, add a settings field, modify a settings page, or add new configurable fields, these patterns apply.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Safe Config Update Patterns

`myco.yaml` is a multi-section document owned by different UI pages and code paths. If any write path reconstructs the config from scratch rather than patching it, it silently drops keys it doesn't know about. This skill teaches the two-layer defense: a single YAML write gate in `loader.ts`, and a spread-before-overlay pattern in every React form. Additionally, Myco uses a two-tier scoped configuration model where team settings live in committed `myco.yaml` while personal overrides live in gitignored `.myco/local.yaml`, enabling per-machine personalization without affecting team defaults.

## Prerequisites

- Understand that `myco.yaml` has independent sections (`vault`, `backup`, `embedding`, `tasks`, etc.) and no single UI page owns the whole file
- Know which section(s) your change targets
- For React form changes: locate the relevant settings page and its `formToConfig()` function
- For programmatic writes: locate `src/config/loader.ts` and `src/config/updates.ts`
- Understand that `myco.yaml` is committed (team-shared) while `.myco/local.yaml` is vault-scoped (gitignored, per-machine)
- Know that config is deep-merged via `loadConfig()` with `arrayStrategy: 'replace'` where local values win
- Recognize that daemon subsystems can subscribe to config changes for live-reload without restart

---

## YAML Writes — The Single Gate Rule

### Why one gate?

If two code paths independently serialize and write `myco.yaml`, they race and one will clobber the other's sections. Even without a race, any path that reconstructs the config from a partial view will lose keys it never read.

The solution: `updateConfig(vaultDir, fn)` in `src/config/loader.ts` is the **only** function that may write `myco.yaml`. It reads the current file, calls your mutation function `fn(config) => config`, and writes the result. This guarantees every write starts from the full current state.

### Steps

1. **Import the gate and helpers:**
   ```ts
   import { updateConfig } from '../config/loader';
   import { withValue, withEmbedding, withTaskConfig } from '../config/updates';
   ```

2. **Use a named helper when one exists.** `src/config/updates.ts` exports typed helpers for common mutations:
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

The Settings UI redesign introduces dedicated PATCH endpoints (`/api/settings/scoped` and `/api/settings/operations`) that replace the monolithic PUT `/api/config` pattern. This enables granular field-level updates without requiring clients to manage the full configuration object. The ScopedField React component automatically handles the patch semantics and scope resolution.

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

2. **ScopedField automatically patches via the correct endpoint:**
   - Personal-scoped settings → `/api/settings/scoped` 
   - Operations settings → `/api/settings/operations`
   - Handles the patch semantics internally

3. **When building custom settings forms, use patch endpoints directly:**
   ```ts
   // For personal/team scoped settings
   await fetch('/api/settings/scoped', {
     method: 'PATCH',
     body: JSON.stringify({
       path: 'embedding.model',
       value: 'text-embedding-3-large',
       scope: 'personal'
     })
   });

   // For operations settings
   await fetch('/api/settings/operations', {
     method: 'PATCH', 
     body: JSON.stringify({
       field: 'auto_run',
       value: true
     })
   });
   ```

4. **Legacy full-config PUT is retired.** New settings UI should use patch-based endpoints exclusively. The `/api/config` PUT endpoint remains for compatibility but is not the primary pattern.

### Benefits over monolithic updates

- **Eliminates config reconstruction bugs** — no need to manage the full config object in forms
- **Automatic scope resolution** — ScopedField handles personal vs team scope assignment  
- **Field-level granularity** — only the specific setting being changed is updated
- **No spread-before-overlay complexity** — the patch semantics handle preservation automatically

---

## Scoped Config Architecture — Two-Tier System

### Understanding the scoped config model

Myco's two-tier scoped configuration enables per-machine personalization without affecting team defaults:

- **`myco.yaml`** — committed team-shared settings that affect how the team collaborates
- **`.myco/local.yaml`** — gitignored per-machine overrides for individual developer preferences

The daemon uses `loadConfig()` to deep-merge these files with `arrayStrategy: 'replace'` where local values win. This allows individuals to override team settings locally without changing the shared configuration.

### Classify New Config Settings by Scope

When adding any new user-configurable behavior, follow these steps to determine which scope tier it belongs in:

**Step 1: Apply the scope decision rule**
If the setting affects how the team collaborates or shares data, it's Project-scoped. If it's about individual developer experience or machine-specific constraints, it's Personal-scoped. Auth flows remain unscoped for security isolation.

**Step 2: Reference the classification matrix**
Use these established patterns as precedent:

*Personal Settings (13 fields):* Per-machine preferences that don't affect team collaboration
- Agent provider/model selection (`agent.provider`, `agent.model`)
- Embedding provider configuration (`embedding.provider`)
- Daemon operational settings (`daemon.port`, `daemon.log_level`)
- UI personalization (`appearance.theme`, `appearance.font_size`, `appearance.dark_mode`, `appearance.density`)
- Notification preferences (`notifications.*`)
- Maintenance automation (`maintenance.auto_optimize`)

*Project Settings (7 fields):* Shared team configuration affecting workflow behavior
- Task configuration (`tasks.*`)
- Symbiont manifest (`symbionts.*`)
- Agent operational limits (`agent.timeout`, `agent.context_window`)
- Vault data policies (`vault.retention_days`, `vault.max_sessions`)
- Team sync enablement (`sync.enabled`)

*Team-Boundary (4 fields):* Auth/onboarding flows deliberately not scoped
- Authentication configuration
- Onboarding workflow settings
- Access control policies
- Audit trail configuration

**Step 3: Document your decision**
Add the new field to the appropriate scope in comments and update any scope defaults matrices in the UI layer.

### Add New Scoped Config Fields

**Step 1: Update the config schema**
Add the new field to the appropriate section in `packages/myco/src/config/schema.ts`:

```typescript
// For Personal-scoped field - add to the appropriate schema
const DaemonSchema = z.object({
  // existing fields...
  new_personal_field: z.string().default("defaultValue"),
});

// For Project-scoped field - add to the appropriate schema
const TasksSchema = z.object({
  // existing fields...
  new_project_field: z.boolean().default(false),
});
```

**Step 2: Verify the PUT /api/config/scoped endpoint handles your field**
The endpoint at `packages/myco/src/daemon/api/config.ts` handles partial patch merging with validation:

```typescript
// Endpoint contract: { scope: 'project' | 'local', patch: {...}, clear?: [...] }
// patch_clear_overlap validation prevents same key in both patch and clear arrays
```

Your new field should automatically work through this endpoint once added to the schema.

**Step 3: Add field to scope defaults matrix (for UI)**
If your field will appear in the daemon UI, update the scope defaults in the appropriate Settings component:

```typescript
// In settings UI component
const scopeDefaults = {
  'existing.field': 'local' as const,
  'new.personal.field': 'local' as const,
  'new.project.field': 'project' as const,
};
```

**Step 4: Handle restart-required fields (if applicable)**
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

---

## Checklist Before Submitting a Config Change

- [ ] YAML write goes through `updateConfig()` (or a named helper that uses it)
- [ ] Every partial update spreads sibling keys at each level
- [ ] `formToConfig()` accepts and spreads the original config (legacy forms only)
- [ ] Settings page only sets fields it owns — no pass-through of other pages' sections
- [ ] Modern settings UI uses ScopedField components or patch endpoints directly
- [ ] If touching daemon-behavior fields, reload signal is sent
- [ ] New scoped config fields have correct scope classification (Personal vs Project vs Team-boundary)
- [ ] Config reactions follow closure factory pattern and idempotency constraints
- [ ] Config toggle side-effects use managed blocks and in-process reconciliation
- [ ] Manual verification: inspect `myco.yaml` after a test save to confirm no data loss