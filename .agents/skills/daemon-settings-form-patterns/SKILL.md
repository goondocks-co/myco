---
name: myco:daemon-settings-form-patterns
description: |
  Use when adding a new config toggle that mutates files beyond myco.yaml
  (e.g., .gitignore writes, AGENTS.md managed blocks), or when building a
  compound provider+model dropdown field in daemon settings UI. Covers two
  patterns not in daemon-ui-development: (1) the 3-step config toggle
  side-effects architecture — boolean flag in myco.yaml → managed block in
  the target file → in-process reconcileConfiguredSymbionts reconciliation,
  fired by the daemon config-reactions on a capture/symbionts config write;
  (2) the ProviderModelSelector compound enum pattern for paired
  provider+model dropdowns where the provider selection resets and filters
  the model list. Also covers .gitignore scope boundaries for file-mutation
  toggles. For core form lifecycle triad (toFormState/builder/dirty-check),
  SectionSaveRow, useCallback dep completeness, and Playwright smoke test
  structure, see the daemon-ui-development skill.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Daemon Settings Form Patterns: Toggle Side-Effects and Compound Fields

This skill covers two advanced patterns for daemon settings UI that are **not** in `daemon-ui-development`:

1. **Config toggle side-effects architecture** — when a settings boolean must write to files beyond `myco.yaml` (`.gitignore`, `AGENTS.md`, etc.)
2. **ProviderModelSelector compound enum pattern** — paired provider+model dropdowns where parent selection drives child filtering and reset

For foundational patterns — form lifecycle triad, `SectionSaveRow`, `useCallback` dep completeness, and Playwright smoke tests — see the **`daemon-ui-development`** skill first.

## Prerequisites

- Read `daemon-ui-development` for the base form lifecycle triad before adding any new settings section
- Know the `myco.yaml` config schema for the feature area you're working on
- Daemon UI source: `packages/myco/ui/src/`
- Config schema: `src/config/schema.ts`
- Config save handler: `src/daemon/routes/config.ts` (or equivalent)
- ESLint `react-hooks/exhaustive-deps` must be enabled and treated as an error

---

## Procedure 1: Config Toggle Side-Effects Architecture

Use this procedure whenever a settings toggle must mutate files beyond `myco.yaml` — for example, writing entries to `.gitignore`, inserting a managed block into `AGENTS.md`, or managing an `.env` template.

The pattern has exactly **3 steps**. Do not skip any step.

### Step 1 — Single Boolean Flag in myco.yaml

Add a single opt-in boolean to the `myco.yaml` config schema. Do **not** add a separate list field to track which paths were mutated — that creates redundancy with the file content itself.

```typescript
// src/config/schema.ts — add one boolean field:
captureIgnorePlanDirsInGit: z.boolean().optional().default(false),
```

**Wrong** — separate list creates redundancy:
```typescript
captureIgnorePlanDirsInGit: z.boolean().optional().default(false),
ignoredPlanDirs: z.array(z.string()).optional(),  // ← DO NOT add; redundant
```

The flag's presence in `myco.yaml` is the source of truth. The file content (managed block) is the derived artifact.

### Step 2 — Managed Block in the Target File

The target file gets a static fenced managed block. The daemon reads and rewrites this block on every reconciliation.

**For `.gitignore`:**
```
# myco:managed:start
plans/
.myco/
# myco:managed:end
```

**For `AGENTS.md` (HTML comment fences):**
```markdown
<!-- myco:managed:start -->
## Myco Agent Rules

...generated content...
<!-- myco:managed:end -->
```

**Lifecycle:**
- `myco init` inserts the block on first installation
- Config save and `myco update` both reconcile the block contents — adding entries when the toggle is enabled, clearing or removing the block when disabled

**Implement reconciliation as an idempotent pure function:**
```typescript
// src/config/reconcile.ts
export function reconcileGitignoreBlock(
  fileContent: string,
  entries: string[],
  enabled: boolean
): string {
  // 1. Strip any existing managed block
  const stripped = stripManagedBlock(fileContent, '# myco:managed');
  if (!enabled || entries.length === 0) return stripped;
  // 2. Append current block
  return stripped + formatManagedBlock('# myco:managed', entries);
}
```

Idempotency requirement: running reconciliation twice must produce the same result as running it once. Always strip before re-inserting.

### Step 3 — In-Process Reconciliation Trigger

A config write must reconcile the target file in-process — never by spawning `myco update` as a subprocess. The daemon wires this through its config-reactions system: a write that touches `capture` or `symbionts` settings fires `reconcileConfiguredSymbionts`, which reconciles the WRITTEN project's `.gitignore` against the current config. (Under the global-install model it reconciles `.gitignore` only; it no longer re-installs project-local symbionts or launchers — hooks are global.)

```typescript
// src/daemon/main.ts — register the reaction once at startup:
reactions.on(['capture', 'symbionts'], (_ctx, scope) => {
  // Per-write scope so a write for project B reconciles project B.
  reconcileConfiguredSymbionts(resolveProjectRoot(scope.vaultDir), scope.vaultDir, scope.groveId);
});
```

**Why in-process, not subprocess:**
- Immediate effect — file mutations complete before the API response returns
- The reconciliation function is unit-testable: pass file content in, assert the output string
- A subprocess (`myco update`) would re-read config from disk, execute asynchronously, and return before the file write completes — Playwright assertions against the file state would be racy

**Gotcha — subprocess timing:** If you spawn `myco update` instead, the `.gitignore` write happens after the API response. Playwright's `waitForRequest` resolves but the file hasn't been written yet. The test appears to pass but the file state is wrong.

---

## Procedure 2: .gitignore Scope Boundaries for File-Mutation Toggles

`.gitignore` is repository-scoped. Only project-relative custom paths belong in the managed block. Apply this filter before computing what to write.

| Path type | Include in managed block? | Reason |
|-----------|--------------------------|--------|
| `plans/` (project-relative) | ✅ Yes | Repo-scoped, correct |
| `local/plans` (project-relative) | ✅ Yes | Repo-scoped, correct |
| `/tmp/plans` (absolute) | ❌ No | Not repo-relative |
| `~/plans` (home-relative) | ❌ No | Not repo-relative |
| Symbiont manifest `planDirs` | ❌ No | Agent-owned; different ownership model |

**Implementation — filter at write time, not read time:**

```typescript
// src/config/gitignore-entries.ts
export function getGitignoreEntries(config: MycoConfig): string[] {
  const customDirs = config.capture?.customPlanDirs ?? [];
  return customDirs.filter(isProjectRelativePath);
}

function isProjectRelativePath(p: string): boolean {
  return !path.isAbsolute(p) && !p.startsWith('~');
}
```

Filter at write time so that if a path becomes non-relative between saves, it is automatically excluded from the next write — stale entries are not left in the block.

**Gotcha — symbiont planDirs are agent-owned:** Symbiont manifest `planDirs` entries describe where an agent captures plans. They belong to the symbiont definition and are not user-configurable custom paths. Including them in `.gitignore` would silently affect agent capture without user intent. Query them separately if needed; never merge them into the user's custom plan dirs list.

---

## Procedure 3: ProviderModelSelector Compound Enum Pattern

Use when a settings section requires the user to select a **provider** and then a **model** scoped to that provider. The provider is the parent field; the model is the child field. Changing the provider must reset the model to a valid default for the new provider.

### Component Structure

```tsx
// packages/myco/ui/src/components/providers/ProviderModelSelector.tsx
interface ProviderModelSelectorProps {
  providers: Provider[];
  selectedProvider: string;
  selectedModel: string;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  disabled?: boolean;
}

export function ProviderModelSelector({
  providers,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
  disabled = false,
}: ProviderModelSelectorProps) {
  const availableModels = useMemo(
    () => providers.find(p => p.id === selectedProvider)?.models ?? [],
    [providers, selectedProvider]
  );

  return (
    <div className="provider-model-selector">
      <select
        value={selectedProvider}
        onChange={e => onProviderChange(e.target.value)}
        disabled={disabled}
      >
        {providers.map(p => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>

      <select
        value={selectedModel}
        onChange={e => onModelChange(e.target.value)}
        disabled={disabled || availableModels.length === 0}
      >
        {availableModels.map(m => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
    </div>
  );
}
```

### Parent-Drives-Child-Reset

When the provider changes, reset the model to the first available model for the new provider. Do this in the **parent's** `onProviderChange` handler — not inside `ProviderModelSelector` itself.

```typescript
// In the settings card that hosts ProviderModelSelector:
function handleProviderChange(newProvider: string) {
  const firstModel =
    providers.find(p => p.id === newProvider)?.models[0]?.id ?? '';
  // Atomic update — provider and model change together:
  setForm(f => ({ ...f, provider: newProvider, model: firstModel }));
}
```

**Why in the parent:** `ProviderModelSelector` is a controlled component with no knowledge of which model values are valid per provider. The parent holds the form state and must reset both fields atomically.

**Gotcha — reset in child causes flash:** If you reset the model inside the component's `onChange`, the model resets before React re-renders with the new provider. This produces a brief render where `selectedModel` is no longer in `availableModels` — visible as a flash of blank selection or console warnings about uncontrolled inputs.

### Dirty-Check with Compound Fields

When computing the `dirty` flag for a section containing `ProviderModelSelector`, include **both** fields:

```typescript
const dirty =
  form.provider !== saved.provider ||
  form.model !== saved.model;
```

Do not check `form.provider` alone — the user may change the model while keeping the same provider.

### useCallback Deps for Compound Save Handlers

When the save handler reads both `form.provider` and `form.model`, both must appear in the `useCallback` dep array. Prefer collecting all form state into a single `form` object and using `builder(form)` to avoid omission:

```typescript
// Preferred — single form object eliminates per-field dep tracking:
const handleSave = useCallback(async () => {
  const patch = builder(form);   // reads all fields from one object
  await updateConfig(patch);
}, [form]);                       // one dep covers all fields
```

---

## Related Skills

| Skill | What it covers |
|-------|---------------|
| **daemon-ui-development** | Form lifecycle triad (toFormState/builder/dirty-check), SectionSaveRow, useCallback dep completeness, Playwright smoke test structure, design tokens, layout |
| **safe-config-updates** | Server-side YAML write path safety — `updateConfig()` invariant, `formToConfig()` spread order |

## Cross-Cutting Gotchas

- **In-process vs subprocess:** the daemon config-reactions run `reconcileConfiguredSymbionts` in-process on a `capture`/`symbionts` write; never shell out to `myco update` — a subprocess delays the effect and breaks Playwright file-state assertions
- **Managed block idempotency:** always strip the existing block before re-inserting; running reconciliation twice must produce identical output
- **Filter paths at write time:** compute `getGitignoreEntries()` fresh on each save so stale or newly-invalid paths are not persisted to the block
- **Symbiont planDirs are agent-owned:** never merge symbiont manifest `planDirs` into user custom plan dir lists; they represent different ownership models
- **Compound field reset is atomic:** changing provider and resetting model must happen in a single `setState` call to avoid invalid transient states
