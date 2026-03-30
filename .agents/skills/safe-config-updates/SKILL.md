---
name: myco:safe-config-updates
description: |
  Apply this skill whenever you need to write, update, or modify Myco configuration — whether from a React settings form, a CLI command, a task, or any other code path. This covers the two linked invariants that prevent silent data loss: (1) all YAML writes must flow through `updateConfig()` in `src/config/loader.ts`, and (2) all React settings forms must spread the original config before overlaying form values in their `formToConfig()` function. Use this skill even if the user hasn't explicitly asked about config safety — any time you touch `myco.yaml`, add a settings field, or modify a settings page, these patterns apply.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Safe Config Update Patterns

`myco.yaml` is a multi-section document owned by different UI pages and code paths. If any write path reconstructs the config from scratch rather than patching it, it silently drops keys it doesn't know about. This skill teaches the two-layer defense: a single YAML write gate in `loader.ts`, and a spread-before-overlay pattern in every React form.

## Prerequisites

- Understand that `myco.yaml` has independent sections (`vault`, `backup`, `embedding`, `tasks`, etc.) and no single UI page owns the whole file
- Know which section(s) your change targets
- For React form changes: locate the relevant settings page and its `formToConfig()` function
- For programmatic writes: locate `src/config/loader.ts` and `src/config/updates.ts`

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

## Checklist Before Submitting a Config Change

- [ ] YAML write goes through `updateConfig()` (or a named helper that uses it)
- [ ] Every partial update spreads sibling keys at each level
- [ ] `formToConfig()` accepts and spreads the original config
- [ ] Settings page only sets fields it owns — no pass-through of other pages' sections
- [ ] If touching daemon-behavior fields, reload signal is sent
- [ ] Manual verification: inspect `myco.yaml` after a test save to confirm no data loss
