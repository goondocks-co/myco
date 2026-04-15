---
name: myco:daemon-ui-development
description: >
  Use when building, extending, or reviewing any page or component in the
  Myco daemon web UI or Collective UI — even if the user doesn't explicitly
  ask about design compliance or testing. Covers: design system token
  integration (6-theme system: sage/moss/terracotta/dusk/plum/slate with ochre
  reserved for Collective, PostCSS @import ordering, CSS cascade specificity,
  theme authoring and browser verification), app shell grammar and
  master-detail layout enforcement, canary signal detection and design drift
  recovery, React component patterns (useCallback deps, SectionSaveRow,
  ScopedField with useScopedConfig, write-on-blur, DotPaths<T>), config page
  architecture with collapsible sections and kebab menus, localStorage
  migration, I/O optimization, Playwright tests, favicon switching, title
  pattern, AppearanceProvider constraints, Vitest fixtures, RedactedField
  gotcha, hard-refresh gotcha. Activates whenever building daemon UI or
  reviewing components for visual compliance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Daemon UI Development

The Myco daemon UI has deliberate design language, layout patterns, and configuration system. Deviating from established patterns causes rework. Two full rewrites of the Collective UI confirm this is a recurring risk.

Apply these procedures whenever touching daemon or Collective UI code, especially for settings and configuration interfaces.

## Prerequisites

- Daemon UI source: `packages/daemon/src/ui/`
- Config module: `src/config/loader.ts` is canonical
- ESLint: `react-hooks/exhaustive-deps` enabled as error
- Theme files: `packages/daemon/src/ui/styles/themes/`
- AppearanceProvider: `packages/daemon/src/ui/components/AppearanceProvider.tsx`
- All YAML writes flow through `updateConfig()` — never write `myco.yaml` or `.myco/local.yaml` directly

## Procedure 1: Design System Token Integration

Never introduce custom color values. Even one hardcoded hex breaks visual consistency.

### 6-Theme System

Six named themes: Sage (default), Moss, Terracotta, Dusk, Plum, Slate. Ochre is reserved for Collective UI only.

### Palette tokens structure

Theme files imported via PostCSS in `src/ui/styles/main.css`:

```css
/* CRITICAL: @import must precede @tailwind directives */
@import './themes/sage.css';
@import './themes/moss.css';
@tailwind base;
@tailwind components;
@tailwind utilities;
```

If `@tailwind` precedes theme `@import`, the theme CSS is silently discarded — no build error.

### CSS cascade and specificity

Theme selectors must use `:root[data-theme="...\"]` to match `:root` specificity. Bare selectors cause source-order nondeterminism:

```css
/* CORRECT */
:root[data-theme="sage"] { --color-primary: #4a7c59; }

/* WRONG — source order wins unpredictably */
[data-theme="sage"] { --color-primary: #4a7c59; }
```

**Before writing CSS:**
1. Inventory current custom properties from theme files
2. Search for hardcoded values: `grep -rn "#[0-9a-fA-F]{3,6}" src/your-surface/`
3. Use daemon tokens; don't invent new variables

## Procedure 1b: Adding a New Theme and Configuring the Appearance System

Adding a new theme requires coordinated changes across a CSS file, a TypeScript union type, `AppearanceProvider`, and the picker component. Several failure modes are invisible to TypeScript/Vitest and only surface in browser.

### Step 1 — Create the CSS file

Create the theme file:

```
packages/daemon/src/ui/styles/themes/<name>.css
```

Minimal structure:

```css
/* IMPORTANT: All @import must precede @tailwind — see Procedure 1 */
:root[data-theme="<name>"] {
  --color-primary: #…;
  --color-surface: #…;
  /* mirror the full token set from an existing theme like sage.css */
}
```

Use `:root[data-theme="<name>"]` (specificity 0,2,0). Bare `[data-theme="<name>"]` (0,1,0) loses to `:root` baseline overrides. See Procedure 1 for the full specificity explanation.

### Step 2 — Import in main.css

In `packages/daemon/src/ui/styles/main.css`:

```css
@import './themes/sage.css';
@import './themes/moss.css';
/* … existing themes … */
@import './themes/<name>.css';   /* ← add here, BEFORE @tailwind */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`@import` must precede `@tailwind`. If placed after, PostCSS silently discards the import — no error, no warning.

### Step 3 — Extend the ThemeName union type

Locate `ThemeName` (in `AppearanceProvider.tsx` or a co-located types file):

```typescript
export type ThemeName = 'sage' | 'moss' | 'terracotta' | 'dusk' | 'plum' | 'slate' | '<name>';
```

TypeScript will surface callers via exhaustiveness checks. It will NOT catch missing CSS custom properties.

### Step 4 — Register in AppearanceProvider and the theme picker

In `AppearanceProvider.tsx`, add the new theme to the `THEMES` array used to apply `data-theme` on `<html>`:

```typescript
const THEMES: ThemeName[] = ['sage', 'moss', 'terracotta', 'dusk', 'plum', 'slate', '<name>'];
```

In the theme picker component (e.g., `ThemePicker.tsx`), add a tile:

```tsx
<ThemeTile name="<name>" label="<Display Name>" />
```

The tile order in the picker should match the order in `THEMES[]`.

**After all four steps, proceed to the browser verification procedure below.**

### Browser-Only Verification — Mandatory Smoke Test

The TypeScript, Vitest, ESLint, and tsc toolchain is completely blind to CSS build and render semantics. A theme can pass all CI checks while being broken in browser. Browser verification is mandatory before shipping any theme change.

**Smoke test steps:**

1. Start the daemon UI dev server (`pnpm dev` in `packages/daemon`)
2. Open DevTools → Elements → select the `<html>` element
3. Confirm `data-theme` attribute is set to the new theme name
4. Open DevTools → Computed tab → filter by `--color-primary` (or another key token)
5. Verify the expected hex value resolves — not empty, not inherited from another theme
6. Switch themes via the Appearance picker → confirm `data-theme` updates on `<html>`
7. Verify the new theme's computed values change correctly on switch
8. Hard-refresh (Cmd+Shift+R / Ctrl+Shift+R) to rule out stale browser cache
9. Screenshot the rendered result before committing

**Diagnosis table — "passes CI, broken in browser":**

| Symptom | Root cause | Fix |
|---------|-----------|--------|
| All custom properties empty | `@import` placed after `@tailwind` | Move `@import` before `@tailwind base` in main.css |
| Theme partially applies | Bare `[data-theme]` specificity loss | Use `:root[data-theme=\"...\"]` |
| Computed properties missing | CSS file not imported in main.css | Add `@import './themes/<name>.css'` |
| Picker shows tile, theme doesn't apply | ThemeName added but THEMES[] not updated | Add to THEMES array in AppearanceProvider |
| Correct DevTools values but wrong on screen | Browser cache stale | Hard-refresh (Cmd+Shift+R) |

### AppearanceProvider Server-Side Import Constraint

`AppearanceProvider` runs in browser context. It must not import any module that references Node.js-only APIs (`node:path`, `node:fs`, `node:os`, etc.). Bundle splits that pull daemon internals into the UI bundle will silently break AppearanceProvider in browser.

**Symptom:** AppearanceProvider starts failing after a refactor that touched config-adjacent imports.

**Wrong pattern — pulls node:* into UI bundle:**

```typescript
import { loadConfig } from '../../config/loader'; // ← node:path inside loader

export function AppearanceProvider({ children }: Props) {
  const config = loadConfig(vaultDir); // breaks in browser
}
```

**Correct pattern — delegate to useScopedConfig hook:**

```typescript
import { useScopedConfig } from '../hooks/useScopedConfig';
import type { AppearanceConfig } from '../../types/config';

export function AppearanceProvider({ children }: Props) {
  const { value: appearance } = useScopedConfig<AppearanceConfig>('appearance', 'personal');
  
  // use appearance.theme, appearance.fontScale, etc. directly
  return (
    <html data-theme={appearance?.theme || 'sage'}>
      {/* … */}
    </html>
  );
}
```

The hook handles config loading outside the UI bundle. No Node.js imports reach the browser. Run `vite build --reporter verbose` to confirm no unexpected Node.js modules appear in the UI bundle.

### Appearance Section UX Pattern

The Appearance settings section follows a locked UX pattern. New appearance controls must fit inside it; do not introduce alternative layouts.

**Locked pattern:**

```
┌─ Appearance ──────────────────── [personal pill: Sage] ──┐
│  (collapsed by default; click header to expand)           │
│                                                           │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ │
│  │ Sage │ │ Moss │ │Terra │ │ Dusk │ │ Plum │ │Slate │ │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ │
│  [Font Scale selector]                                    │
└───────────────────────────────────────────────────────────┘
```

Rules:
- The section header always shows a preview pill of the current personal theme
- Expanding reveals the full theme grid picker
- Theme and font scale default to **Personal** scope (written to `.myco/local.yaml`)
- New appearance controls (e.g., density, icon size) go inside this collapsible section, following the same personal-scope default
- If a design calls for a non-collapsible or non-pill appearance control, redirect to this pattern

### Vitest and the local.yaml Test Mental Model

Vitest tests that mock `vaultDir` load `myco.yaml` from the fixture directory but **do not load `.myco/local.yaml`** unless the fixture explicitly contains one. Appearance preferences (theme, font scale) are written to the local scope. Tests that omit `local.yaml` from their fixture will see project defaults instead of personal overrides.

**Symptom:** Test passes. In production, the user's chosen theme reverts to the project default on next load. The write went to `local.yaml`, but the test fixture never included it.

**Incomplete fixture — misses personal layer:**

```
test-fixtures/vault/
  myco.yaml          ← loads fine, but personal prefs invisible
```

**Complete fixture — covers both config layers:**

```
test-fixtures/vault/
  myco.yaml          ← project defaults
  local.yaml         ← personal overrides (appearance.theme, appearance.fontScale)
```

**Assert the write scope and verify round-trip:**

```typescript
// 1. Confirm the write went to local scope
expect(writtenScope).toBe('local');

// 2. Read local.yaml directly to verify the value persisted
const localConfig = readYaml(path.join(testVaultDir, 'local.yaml'));
expect(localConfig.appearance?.theme).toBe('moss');
```

When authoring tests for any appearance preference, always include `local.yaml` in the fixture and assert `scope === 'local'` on the write.

## Procedure 2: App Shell Grammar and Master-Detail Layout

Daemon pages use **master-detail layout**: left list/overview, right detail/inspector. Full-width or centered-column layouts are incorrect.

**Extract, do not rebuild:** Nav rail, sidebar, and page shell are structural primitives. Extract them rather than rebuilding chrome from scratch. Both Collective UI rewrites required full visual rework because the structural language diverged.

**Master-detail pattern:**
```
┌──────────────────────┬───────────────────────────┐
│  Left: list/overview │  Right: detail/inspector   │
└──────────────────────┴───────────────────────────┘
```

## Procedure 3: Canary Signal Detection and Design Drift Recovery

Design drift is detectable via three signals. Stop and audit when any appear.

**The three signals:**

| Signal | Correct | Wrong |
|--------|---------|------------|
| Color | Sage, moss, terracotta, dusk, plum, slate via `--color-primary` | Brown, warm neutrals, arbitrary hex, ochre in daemon CSS |
| Navigation | Solid structural rail | Bubble-bordered or rounded nav pills |
| Font size | Daemon density (tight) | Large editorial scale |

**Recovery (in order):**
1. List custom CSS variables not from daemon shell
2. Replace with daemon token equivalents
3. Find rebuilt structural chrome; replace with extracted components
4. Verify master-detail layout, PostCSS order, theme CSS specificity
5. Re-run detection
6. Screenshot before merging

## Procedure 4: React Component Patterns

### useCallback dep completeness

Every `useCallback` must list all captured state/prop variables. Missing deps cause stale-closure bugs:

```typescript
// CORRECT
const handleSave = useCallback(async () => {
  await saveConfig({ ignoreInGit });
}, [ignoreInGit]);
```

ESLint's `react-hooks/exhaustive-deps` catches these. Never suppress it.

### SectionSaveRow and builder pattern

Config forms use per-section save. Each section ends with `<SectionSaveRow>` showing Save/Cancel only when unsaved changes exist.

```typescript
// 3. Build updated config — spread original FIRST, overlay form
function formToConfig(original: MyConfig, form: FormState): MyConfig {
  return { ...original, ...form };  // ← original FIRST
}
```

**CRITICAL**: Spread `original` before overlaying `form`. Reversing silently drops fields not in the form.

### ScopedField pattern — Path-based API (PR #80+)

`ScopedField` uses path-based declarative API for composability and type-safety:

```tsx
<ScopedField
  path="daemon.log_level"
  defaultScope="personal"
  label="Log Level"
>
  {(value, onChange) => (
    <Select value={value} onChange={onChange} />
  )}
</ScopedField>
```

**Key behaviors:** DotPath<T> typing (type-safe paths at compile-time), render prop pattern, Personal/Team scope UI with clickable scope pill, requiresRestart flag for daemon restarts, automatic notification emissions.

### useScopedConfig hook

For reading/updating scoped config outside `ScopedField`, use `useScopedConfig`:

```typescript
const { value, setValue, scope, setScope, isDirty, isSaving, error } = 
  useScopedConfig<T>(path, defaultScope);
```

Hook automatically persists changes and emits notifications.

### Write-on-blur vs. write-on-change

**Write-on-blur (text inputs):** Collect locally, save on blur. Prevents daemon validation of incomplete values.

**Write-on-change (toggles/selects):** Save immediately for finite-value inputs.

## Procedure 5: Config System Architecture — Two-Tier File Model

Configuration splits across two YAML files that deep-merge on load:

| File | Committed | Scope | Purpose |
|------|-----------|-------|------------|
| `myco.yaml` | ✅ yes | Project/team | Shared defaults |
| `.myco/local.yaml` | ❌ gitignored | Per-machine | Personal overrides |

`loadConfig()` deep-merges with local winning. **Arrays are replaced, not concatenated.**

### Config write invariant — updateConfig() single write path

**INVARIANT**: All YAML writes flow through `updateConfig()` in `src/config/loader.ts`. Never write files directly. Diverging write paths cause silent serialisation bugs.

```typescript
await updateConfig(vaultDir, partialConfig, scope);  // scope: 'project' | 'local'
```

### REST API: scope-aware patch endpoint

```
PUT /api/config/scoped
Body: { "scope": "project" | "local", ...fieldUpdates }
```

Patch-style: merges partial object onto file. Route handlers call `updateConfig()` internally.

## Procedure 6: Config Toggle Side-Effects and Managed Blocks

Some toggles require file mutations beyond `myco.yaml` (e.g., `.gitignore`, `tsconfig.json`). Use managed-block pattern:

**Step 1:** Single opt-in boolean in `myco.yaml`
**Step 2:** Static managed block in affected file, inserted by `myco init`, reconciled by `myco update`
**Step 3:** In-process reconciliation after config save:

```typescript
await symbionts.reconcile(vaultDir, updatedConfig);
```

## Procedure 7: Configuration Page Architecture and Form Safety

### Page types

**Dashboard:** Status summary only. "Configure →" link to dedicated page.

**Dedicated config page:** Route (e.g., `/mcp-settings`) for multi-step setup, agent-specific instructions, multiple sections.

### React form safety

**Failure 1 — Field loss:**

```typescript
// ✅ CORRECT — preserves unrelated fields
return { ...current, theme: formValues.theme, font: formValues.font };
```

**Failure 2 — Stale closure:**

```typescript
// ✅ CORRECT — recreates when state changes
const handleSave = useCallback(() => {
  await saveFn(formToConfig(formValues, currentConfig));
}, [formValues, currentConfig]);
```

## Procedure 8: Configuration Page UI and Scope Defaults

### Collapsible sections

**Sidebar:** Collapse to icon-only. Persist to `localStorage` under `sidebar-collapsed`.

**Content:** Hide content, title remains. Persist to `localStorage` under `section-visibility-<name>`.

**localStorage exception:** UI layout state uses `localStorage`. Config values use vault/project file.

### Section kebab menu

**Batch promote:** Copy all Personal settings in section to Team scope.

**Reset all:** Clear overrides, revert to project defaults.

### Scope defaults matrix

**Personal (machine-local):** Log level, bind address, TLS paths, IDE paths, font size, theme, timezone, resource limits, refresh intervals.

**Team (shared):** Project name, notification modes, MCP servers, archive policies, symbiont config, experimental features, excluded paths.

Default to **Personal** scope when unlisted.

## Procedure 9: Playwright Smoke Tests

Every config form needs Playwright smoke test verifying no silent value discards.

**What to test:**
1. Toggle round-trip (save → reload → still enabled)
2. API POST has correct value (intercept, assert payload)
3. Visual state consistency (UI reflects saved state after reload)

```typescript
test('config toggle round-trips correctly', async ({ page }) => {
  await page.goto('/mcp-settings');
  const [request] = await Promise.all([
    page.waitForRequest(req => req.url().includes('/api/config') && req.method() === 'POST'),
    page.click('[data-testid="toggle"]'),
    page.click('[data-testid="save-section"]'),
  ]);
  expect(request.postDataJSON().field).toBe(true);
  await page.reload();
  await expect(page.locator('[data-testid="toggle"]')).toBeChecked();
});
```

## Procedure 10: Configuration Migration and I/O Optimization

### localStorage → file migration

Check if `localStorage` has old keys. If found, read them, merge into config, write to persistent store. Add cleanup TODO:

```typescript
// TODO(2026-04-30): Remove localStorage migration code
```

Do NOT set sentinel flags.

### I/O optimization

Skip write when unchanged, use useMemo for appearance context, guard DOM mutations, single loadConfig() per page.

## Cross-Cutting Gotchas

- **PostCSS @import ordering is silent:** If theme `@import` appears AFTER `@tailwind`, theme CSS discarded silently.
- **CSS specificity requires `:root[data-theme=\"...\"]`:** Bare selectors cause source-order nondeterminism.
- **Screenshot before merging:** Catches design drift code review misses.
- **`formToConfig` spread order is silent:** No runtime error when reversed. Symptom: production data loss. Test with Playwright.
- **ESLint hooks rule is first line of defence:** Never suppress `react-hooks/exhaustive-deps`.
- **updateConfig() is the single write path:** Never write YAML directly.
- **Local .myco/local.yaml path is already scoped:** Don't prepend `.myco/` again. Use `path.join(vaultDir, 'local.yaml')`.
- **Array replacement, not merge:** Local array completely replaces project array.
- **Hard-refresh browser cache:** Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows/Linux).
- **DotPaths<T> recursive template literal typing:** Type-check config paths at compile time.
- **Favicon-per-theme SVG switching:** SVG files must exist in `public/favicons/theme-{name}.svg`.
- **Dynamic page title pattern:** Format `Myco — <project-name>` from `myco.yaml`.
- **RedactedField copy-button gotcha:** Pass real token to CopyButton, not masked displayValue.
- **localStorage for UI state only:** Collapse/reveal state in localStorage. Config values in vault/project file.
- **Theme file creation without registration:** Creating a .css file without adding it to ThemeName union and THEMES array results in silent no-op.
- **AppearanceProvider bundle split risk:** Never import config loaders or Node.js modules inside AppearanceProvider. Use the useScopedConfig hook pattern instead, which handles config loading outside the UI bundle context.
- **Appearance preference write scope is always 'local':** Theme and font scale overrides go to `.myco/local.yaml`, not `myco.yaml`. Personal machine scope.
