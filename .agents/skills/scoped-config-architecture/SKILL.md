---
name: myco:scoped-config-architecture
description: |
  Covers adding and classifying new config settings using Myco's two-tier scoped config model 
  (myco.yaml + .myco/local.yaml), implementing the PUT /api/config/scoped endpoint contract, 
  and setting up config-change reactions via the ConfigReactionRegistry. Includes scope 
  classification matrix (Personal vs Project vs Team-boundary), closure factory patterns 
  for reactions, and config toggle side-effects management. Use when adding any new 
  user-configurable behavior, daemon settings, or agent preferences that need live-reload 
  capabilities.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Scoped Config Architecture and Reaction System

Myco uses a two-tier scoped configuration model where team settings live in committed `myco.yaml` while personal overrides live in gitignored `.myco/local.yaml`. This architecture enables per-machine personalization without affecting team defaults, plus a reactive system for live-reloading daemon subsystems when config changes.

## Prerequisites

- Understand that `myco.yaml` is committed (team-shared) while `.myco/local.yaml` is vault-scoped (gitignored, per-machine)
- Know that config is deep-merged via `loadConfig()` with `arrayStrategy: 'replace'` where local values win
- Recognize that daemon subsystems can subscribe to config changes for live-reload without restart

## Procedure A: Classify New Config Settings by Scope

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

## Procedure B: Add New Scoped Config Fields

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

## Procedure C: Set Up Config-Change Reactions

Use `registry.on(pathPrefixes, handler)` from the ConfigReactionRegistry to subscribe daemon subsystems to config changes for live-reload.

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

## Procedure D: Implement Config Toggle Side-Effects

For `myco.yaml` boolean toggles requiring file mutations (like symbiont installation), use the established pattern:

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

## Cross-Cutting Gotchas

**Local config path construction:** In `localConfigPath()`, `vaultDir` already includes `.myco`, so use `path.join(vaultDir, LOCAL_CONFIG_FILENAME)` directly. Don't prepend `.myco/` again or you'll get `.myco/.myco/local.yaml` double-nesting.

**Path-prefix subscription semantics:** `registry.on(['agent'])` triggers for `agent.model`, `agent.provider`, `agent.timeout`, etc. Use specific paths like `['agent.model']` if you only care about model changes.

**Merge strategy implications:** `arrayStrategy: 'replace'` in `deepMergeConfig()` means local arrays completely replace project arrays. For additive behavior, use object merging instead of arrays.

**Scope pill UX pattern:** The UI uses per-field scope indicators (Personal/Project pills) rather than section-level grouping. This supports mixed-scope forms and field-level override visibility.

**Registry vs. direct config reads:** Use the `config` parameter passed to reactions for performance. The registry has already paid the YAML + schema parse cost once. Only call `loadConfig()` separately if you need to detect concurrent changes during reaction processing, which is rare.