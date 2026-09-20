# Scoped Config Architecture — Three-Tier System

Reference material for the `safe-config-updates` skill.

# Scoped Config Architecture — Three-Tier System

## Understanding the three-tier scoped config model

Myco's three-tier scoped configuration enables machine-global defaults, grove-level coordination, project team settings, and per-machine personalization:

- **Machine tier** (`~/.myco/config.yaml`) — global daemon configuration across all groves and projects
- **Grove tier** (`~/.myco/groves/<id>/grove.yaml`) — grove-level settings that coordinate across multiple projects within a grove
- **Project tier** (`myco.yaml`) — committed team-shared settings that affect how the team collaborates
- **Personal tier** (`.myco/local.yaml`) — gitignored per-machine overrides for individual developer preferences

The daemon uses `loadMergedConfig()` which calls `pruneToTier(raw, tier)` for each tier before merging. `pruneToTier` is the **primary enforcement mechanism** — it uses `SCOPE_REGISTRY` from `packages/myco/src/config/scope.ts` to keep only leaf paths whose `home` or `overridableBy` tiers allow them. Deep-merge follows with `arrayStrategy: 'replace'` where higher-tier (personal) values win.

## Grove architecture coordination patterns

**Multi-project coordination**: Grove's global daemon architecture introduces additional configuration layers for coordinating settings across multiple project vaults within a grove. The global daemon maintains grove-level configuration that provides defaults for project-level settings.

**Migration compatibility**: Grove migration procedures can update existing project configurations to reference grove-global settings where appropriate, maintaining backward compatibility while enabling grove-wide coordination.

**Initialization patterns**: Grove-aware init procedures detect and integrate with existing project configurations, ensuring smooth onboarding without disrupting established project settings.

**Config tier migration patterns**: When migrating configurations to grove coordination, preserve existing project config semantics while adding grove-level defaults. Ensure that migrated configurations maintain the same effective behavior for teams that don't use grove features.

## Classify New Config Settings by Tier

When adding any new user-configurable behavior, follow these steps to determine which tier it belongs in:

**Step 1: Apply the tier decision rule**
- **Machine tier**: Global daemon behavior across all groves (port, logging, global auth, capture policy)
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
- Capture policy (`capture.*`) — strictly machine-scoped, no overrides allowed

**Step 3: Add the field to SCOPE_REGISTRY and the Zod schema**
New fields must be registered in `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts` with the correct `home` tier and `overridableBy` array. The scope-registry sync test will fail if a schema leaf is not covered, so ratify against the Zod tier schemas in `packages/myco/src/config/schema.ts`.

**Step 4: Document the decision**
Add the new field to the appropriate tier in comments and update any scope defaults matrices in the UI layer.

## Handle Legacy Config Fields During Tier Migration

When architectural changes move fields between tiers, two mechanisms cooperate:

**Primary enforcement — `pruneToTier()`**: The loader calls `pruneToTier(raw, tier)` for every tier in `loadMergedConfig`. This uses `SCOPE_REGISTRY` to silently drop any fields that don't belong to the given tier — so once a field's `home` tier is updated in the registry, misplaced values in other tiers are automatically ignored at load time.

**Legacy strip — `PROJECT_TIER_LEGACY_FIELDS`**: For fields that historically lived in the wrong tier and need to be actively removed from committed `myco.yaml` files (not just ignored), add them to `PROJECT_TIER_LEGACY_FIELDS` in `packages/myco/src/config/schema.ts`. The loader's `stripLegacyProjectFields()` function iterates this list and calls `unsetAtPath()` to physically remove them from the YAML document, preventing stale fields from cluttering project configs.

**`GROVE_PROMOTED_FIELDS` — Grove-tier conditional stripping**: `GROVE_PROMOTED_FIELDS` (also exported from `packages/myco/src/config/schema.ts`) is a companion array listing the subset of fields that belong specifically to Grove tier — embedding settings, agent provider, agent harness, agent model, and agent scheduling fields. See the array definition in schema.ts for the current list. This array is spread into `PROJECT_TIER_LEGACY_FIELDS`, but with a critical conditional: `stripLegacyProjectFields()` only strips these fields when the project is Grove-bound (`hasGrove: true`). If no Grove exists yet, the values are retained in `myco.yaml` so they aren't lost. Once the project binds to a Grove, `myco update` lifts the values to Grove tier and then strips them from the project YAML.

**When to use each:**
- New field at correct tier from day one → just add to `SCOPE_REGISTRY`; `pruneToTier` enforces it automatically
- Field moved from project → grove tier → add to `SCOPE_REGISTRY` with new home; also add to `GROVE_PROMOTED_FIELDS` (and by extension `PROJECT_TIER_LEGACY_FIELDS`) so the old project-tier value gets stripped from `myco.yaml` once Grove is bound
- Field removed entirely → add to `PROJECT_TIER_LEGACY_FIELDS` directly to clean up existing configs; no registry entry needed

This silent-strip pattern ensures that when developers pull code with a tier reorganization, old fields in `myco.yaml` do not interfere with new grove-tier values, preventing silent shadowing of grove defaults.

## Two-Layer Config Migration Procedures

When migrating existing projects to a new config architecture, use a two-layer approach:

**Layer 1: Client-side silent strip**
The client removes legacy fields during `loadConfig()` before merging via `stripLegacyProjectFields()`. This protects against old project-tier fields shadowing new grove-tier defaults.

**Layer 2: Daemon-side reconciliation**
On next daemon startup after the migration-aware code is deployed, the daemon detects legacy fields in `myco.yaml` and offers a migration guide. This allows teams to understand what changed without breaking existing setups.

Use `loadMergedConfig(vaultDir, { groveId })` to automatically resolve grove-tier settings via the specified grove ID, integrating grove defaults into the final merged config.

## Add New Scoped Config Fields

**Step 1: Update the config schema**
Add the new field to the appropriate section in `packages/myco/src/config/schema.ts`.

**Step 2: Register the field in SCOPE_REGISTRY**
Add the new field to `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts` with correct `home` and `overridableBy`. The scope-registry sync test will fail if this entry is missing.

**Step 3: Verify the scoped config endpoint handles the new field**
The endpoint at `packages/myco/src/daemon/api/config.ts` handles partial patch merging with validation via `handlePutScopedConfig`:
```typescript
// Endpoint contract: { scope: 'project' | 'local', patch: {...}, clear?: [...] }
// patch_clear_overlap validation prevents same key in both patch and clear arrays
```

**Step 4: Add field to scope defaults matrix (for UI)**
If the field will appear in the daemon UI, update the scope defaults in the appropriate Settings component.

**Step 5: Handle restart-required fields (if applicable)**
If the field requires daemon restart rather than live-reload, document it in the settings UI and ensure the save handler sends the appropriate IPC restart signal alongside the config write.

---
