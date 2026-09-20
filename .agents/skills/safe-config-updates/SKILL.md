---
name: safe-config-updates
description: >-
  This skill should be used when the user asks to "add a setting", "add a field to the
  settings page", "change myco.yaml", or when any code path writes configuration — a React
  settings form, a CLI command, a task, or a daemon reaction. Covers the two invariants that
  prevent silent config loss (every YAML write flows through `updateConfig()`; every
  `formToConfig()` spreads the original config before overlaying form values) and the full
  procedure for adding a scoped setting across the machine/grove/project/personal tiers.
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Safe Config Update Patterns

`myco.yaml` is a multi-section document owned by different UI pages and code paths. If any write path reconstructs the config from scratch rather than patching it, it silently drops keys it doesn't know about. This skill teaches the two-layer defense: a single YAML write gate in `packages/myco/src/config/loader.ts`, and a spread-before-overlay pattern in every React form. Additionally, Myco uses a three-tier scoped configuration model where machine-global settings live in `~/.myco/config.yaml`, grove-level settings live in `~/.myco/groves/<id>/grove.yaml`, project-team settings live in committed `myco.yaml`, while personal overrides live in gitignored `.myco/local.yaml`, enabling per-machine personalization and multi-project coordination without affecting team defaults.

## Prerequisites

- Understand that `myco.yaml` has independent sections (`vault`, `backup`, `embedding`, `tasks`, etc.) and no single UI page owns the whole file
- Know which section(s) the change targets
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

The solution: `updateConfig(vaultDir, fn)` in `packages/myco/src/config/loader.ts` is the **only** function that may write `myco.yaml`. It reads the current file, calls the supplied mutation function `fn(config) => config`, and writes the result. This guarantees every write starts from the full current state.

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

### Machine/Grove Tier Writes — `updateTierConfigRaw`

`updateConfig()` is for the **project tier** (`myco.yaml`). Machine (`~/.myco/config.yaml`) and grove (`~/.myco/groves/<id>/grove.yaml`) tier writes use `updateTierConfigRaw()` from `packages/myco/src/config/loader.ts`:

```ts
import { updateTierConfigRaw } from '../config/loader';

// Write to machine tier
updateTierConfigRaw({ kind: 'machine' }, (raw) => {
  (raw as Record<string, unknown>).capture = { ...(raw.capture as object ?? {}), enabled: false };
  return raw as Record<string, unknown>;
});

// Write to grove tier
updateTierConfigRaw({ kind: 'grove', groveId }, (raw) => {
  return { ...raw, 'agent': { ...(raw.agent as object ?? {}), model: 'claude-opus-4-5' } };
});
```

`updateTierConfigRaw` reads the raw on-disk YAML, calls the supplied mutation function, validates tolerantly (unknown keys preserved on disk; value violations throw `ZodError`), and persists atomically. Unlike `updateConfig`, it throws `TierConfigUnreadableError` when the target file has corrupt YAML or a non-mapping root — preventing silent file wipes.

### Grove-specific considerations

**Global daemon coordination**: Grove's global daemon architecture means config changes may need coordination across multiple project vaults. Use the appropriate grove-aware config loader when working in a multi-project context.

**Migration patterns**: Grove migration introduces new config layering where project-local configs can reference grove-global settings. Ensure config updates respect these layered dependencies and don't break grove coordination.

**Tier migration compatibility**: When implementing features that modify configuration across projects, ensure compatibility with config tier migration patterns. Project configurations should remain functional when migrated to grove coordination models.

### Secrets File Writes — Prototype-Safe Decoding Guard

The secrets file (`SECRETS_FILE` constant in `packages/myco/src/config/secrets.ts`) is a separate write surface from `myco.yaml` but carries the same silent-corruption risk. `decodeSecrets()` builds the parsed record with `Object.create(null)` instead of a plain object literal, and rejects any key in the `PROTOTYPE_LIKE_ENV_KEYS` set (`__proto__`, `prototype`, `constructor`) before assignment, preventing prototype-pollution via a crafted secrets file. `decodeSecretBuffer()` also decodes with `new TextDecoder('utf-8', { fatal: true })`, throwing on malformed byte sequences rather than silently substituting replacement characters.

Encode-time validation of a value about to be written is not sufficient on its own — any code path that reads or mutates secrets must go through `readSecretsFile()`/`decodeSecrets()` so the prototype-safe decode and strict UTF-8 check apply consistently. Don't add ad-hoc parsing of the secrets file elsewhere.

### Pitfall: append-only gitignore staleness

`myco.yaml` contains a `gitignore` section with patterns that the daemon writes to `.gitignore`. This section is managed with a strip-and-rewrite strategy (the daemon removes the old Myco block and writes a fresh one), not with `updateConfig`. Don't conflate these: `.gitignore` writes are strip-and-rewrite, `myco.yaml` writes go through the gate.

---

## React Settings Forms — Spread Before Overlay

**Note:** `formToConfig()` no longer exists in the codebase — settings pages have migrated to the ScopedField/patch-based API (see below), which handles spread-before-overlay internally. The pattern below documents the underlying principle for any custom save handler that still assembles a config object by hand.

### Why spread?

A settings page only renders fields for its own section. If a hand-rolled save handler reconstructs a config object from form state from scratch, every key it doesn't render disappears on save — including keys owned by other pages, keys added by future features, and keys set programmatically.

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

4. **`auto_run` requires a hot-reload signal.** If the form touches `vault.auto_run` or any field that controls daemon behavior, the daemon won't pick it up until it restarts or receives a reload event. The config write alone is not sufficient — ensure the save handler also sends the appropriate IPC signal.

### Pitfall: silent key dropping is invisible

Config data loss from the `formToConfig()` bug is silent at the UI layer — the save appears to succeed, but keys vanish from `myco.yaml`. The only way to notice is to inspect the YAML after saving. When adding a new settings field, always open `myco.yaml` after the first test save and verify unrelated sections are intact.

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

## Additional Resources

- **`references/reactions-and-side-effects.md`** — Config-Change Reactions and Toggle Side-Effects
- **`references/scoped-config-tiers.md`** — Scoped Config Architecture — Three-Tier System

## Cross-Cutting Gotchas

**Silent key dropping is invisible:** Config data loss from the `formToConfig()` bug is silent at the UI layer — the save appears to succeed, but keys vanish from `myco.yaml`. The only way to notice is to inspect the YAML after saving. When adding a new settings field, always open `myco.yaml` after the first test save and verify unrelated sections are intact.

**Local config path construction:** In `localConfigPath()`, `vaultDir` already includes `.myco`, so use `path.join(vaultDir, LOCAL_CONFIG_FILENAME)` directly. Don't prepend `.myco/` again or the result is `.myco/.myco/local.yaml` double-nesting.

**Path-prefix subscription semantics:** `registry.on(['agent'])` triggers for `agent.model`, `agent.provider`, `agent.timeout`, etc. Use specific paths like `['agent.model']` to match only model changes.

**Merge strategy implications:** `arrayStrategy: 'replace'` in `deepMergeConfig()` means local arrays completely replace project arrays. For additive behavior, use object merging instead of arrays.

**Scope pill UX pattern:** The UI uses per-field scope indicators (Personal/Project pills) rather than section-level grouping. This supports mixed-scope forms and field-level override visibility.

**Registry vs. direct config reads:** Use the `config` parameter passed to reactions for performance. The registry has already paid the YAML + schema parse cost once. Only call `loadConfig()` separately to detect concurrent changes during reaction processing, which is rare.

**Grove migration config compatibility:** When working with grove-aware configurations, ensure backward compatibility with pre-grove project configs. Grove migration procedures should preserve existing project settings while enabling grove coordination.

**Multi-project configuration isolation:** Grove's global daemon coordinates multiple projects, but config changes should maintain appropriate isolation between projects unless explicitly designed for grove-wide coordination.

**Three-tier merge precedence:** Remember that personal overrides win over project settings, which win over grove settings, which win over machine defaults. When debugging config issues, check all four tiers in the merge chain.

**Binding a reused settings component to a new config target — context, not prop-threading.** When adapting an existing scoped-config component (e.g., `useScopedConfigForSelection` in `packages/myco/ui/src/hooks/use-scoped-config.tsx`) to serve a different target — such as a Team-scoped settings surface — prefer a React context that the shared hook reads internally over threading a target prop through every consumer. This keeps the component reusable without forking it as new scoped surfaces (e.g., team settings) are added.

**Grove-tier scope selection:** When adding grove-level settings, ensure they truly coordinate across projects rather than duplicating project-level functionality. Grove settings should enable multi-project workflows, not replace project autonomy.

**Config tier migration false positives:** During drift analysis, config property paths like `myco.yaml` and `backup.dir` are configuration property references, not missing file paths. Verify that core config safety functions remain present in the loader module before assuming drift.

**Legacy field shadowing:** When adding to PROJECT_TIER_LEGACY_FIELDS for migration, ensure the strip happens at load time before tier merging. If a legacy project-tier `agent.provider` exists alongside a new grove-tier `agent.provider`, the legacy field will shadow the grove value until it's stripped. Note: fields in `GROVE_PROMOTED_FIELDS` are only stripped when the project is Grove-bound (`hasGrove: true`) — they remain in `myco.yaml` until a Grove is available to receive the migrated value.

**SCOPE_REGISTRY sync test:** A scope-registry sync test enforces that every Zod schema leaf has a registry entry. After adding a new config field to the schema, always add it to `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts` — or the test will fail loudly.

**loadMergedConfig groveId resolution:** `loadMergedConfig(vaultDir, { groveId })` automatically resolves and merges grove-tier configuration from `~/.myco/groves/<groveId>/grove.yaml` when groveId is provided. When groveId is not provided, it auto-resolves from `loadProjectManifest(vaultDir)`. If groveId is undefined and the project manifest contains no grove association, grove-tier settings are skipped.

**Scoped-clear pruneEmptyParents omission:** When writing `unsetAtPath()` calls in a scoped-clear loop, always pass `{ pruneEmptyParents: true }`. Without it, deleting the last leaf under a parent key leaves an empty-map object as residue in the persisted YAML instead of removing the parent entirely.

**`TierConfigUnreadableError` on corrupt machine/grove config:** `updateTierConfigRaw()` throws `TierConfigUnreadableError` (from `packages/myco/src/config/loader.ts`) when the target file has invalid YAML or a non-mapping root — protecting against silently wiping a corrupt file. `updateConfig()` (project tier) does NOT throw this; it tolerates corrupt YAML by treating the file as empty. Callers of `updateTierConfigRaw` must catch `TierConfigUnreadableError` and surface it as a user error (API callers: return 422). The daemon uses `setTierParseFailureListener()` to register a notification callback for non-fatal tier read failures logged to stderr; the listener replays failures that occurred before it was registered so no pre-boot corruption goes unnoticed.

**capture config is strictly machine-scoped:** The `capture` config section has `home: 'machine', overridableBy: []` in SCOPE_REGISTRY — the entire section, including the `ignore` sub-object (with its `paths` and `patterns` arrays), cannot be overridden by project or grove tiers. When debugging why a project root is excluded from capture, check `~/.myco/config.yaml` (the machine config), not `myco.yaml` or `~/.myco/groves/<id>/grove.yaml`.

**Capability gating via capabilityEnabled():** Features controlled by a named capability must be checked via `capabilityEnabled(config, capId)` from `packages/myco/src/config/capabilities.ts`, not by reading config fields directly. The function is fail-closed — null or undefined config returns false. Adding a new capability-gated feature: (1) add an entry to `CAPABILITIES`; (2) add its ID to `CAPABILITY_IDS` in `packages/myco/src/config/scope.ts`; (3) call `capabilityEnabled()` at every gate-check site.

---

## Checklist Before Submitting a Config Change

- [ ] Secrets reads/writes go through `readSecretsFile()`/`decodeSecrets()` in `packages/myco/src/config/secrets.ts` — never hand-parse the secrets file
- [ ] YAML write goes through `updateConfig()` (or a named helper that uses it) for project tier
- [ ] Machine/grove tier writes use `updateTierConfigRaw()`; callers catch `TierConfigUnreadableError` and surface as 422
- [ ] Every partial update spreads sibling keys at each level
- [ ] `formToConfig()` accepts and spreads the original config (legacy forms only)
- [ ] Settings page only sets fields it owns — no pass-through of other pages' sections
- [ ] Modern settings UI uses ScopedField components or patch endpoints directly
- [ ] If touching daemon-behavior fields, reload signal is sent
- [ ] New scoped config fields added to both Zod schema AND `SCOPE_REGISTRY` in `packages/myco/src/config/scope.ts`
- [ ] Config reactions follow closure factory pattern and idempotency constraints
- [ ] Config toggle side-effects use managed blocks and in-process reconciliation via `reconcileConfiguredSymbionts` from `packages/myco/src/symbionts/reconcile.ts`
- [ ] Grove architecture compatibility considered for multi-project coordination
- [ ] Three-tier merge precedence understood and documented
- [ ] Config tier migration compatibility verified for grove coordination features
- [ ] Legacy field handling: use `PROJECT_TIER_LEGACY_FIELDS` (or `GROVE_PROMOTED_FIELDS` for Grove-tier fields) in schema.ts for fields that need physical removal from project YAML; `pruneToTier` auto-enforces scope for everything else
- [ ] GROVE_PROMOTED_FIELDS entries only stripped when project is Grove-bound — retained in myco.yaml until Grove exists
- [ ] Scoped-clear operations pass `{ pruneEmptyParents: true }` to `unsetAtPath()` to avoid empty-map residue
- [ ] Capability-gated features use `capabilityEnabled(config, capId)` from `packages/myco/src/config/capabilities.ts`, not direct config reads
- [ ] Manual verification: inspect `myco.yaml` after a test save to confirm no data loss
