---
name: myco:daemon-ui-development
description: >
  Use when building, extending, or reviewing any page or component in the
  Myco daemon web UI or Collective UI — even if the user doesn't explicitly
  ask about design compliance or testing. Covers: design system token
  integration (6-theme system: sage/moss/terracotta/dusk/plum/slate with ochre
  reserved for Collective, PostCSS @import ordering, CSS cascade specificity),
  app shell grammar and master-detail layout enforcement, canary signal
  detection and design drift recovery, React component patterns (useCallback
  deps, SectionSaveRow, toFormState/builder, ScopedField), configuration page
  architecture with collapsible sections and kebab menus, localStorage→file
  migration with idempotent design, I/O optimization patterns, Playwright smoke
  tests with computed CSS verification, favicon-per-theme SVG switching,
  dynamic title pattern, RedactedField copy-button gotcha. Activates whenever
  building daemon UI pages, reviewing components for visual compliance, or
  debugging stale-closure bugs.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Daemon UI Development

The Myco daemon UI has a deliberate design language — a specific color palette, layout grammar, and component vocabulary. Deviating from it is the single most common source of rework in new UI surfaces. Two full rounds of rework on the Collective UI confirm this is a recurring risk, not a one-time mistake.

Apply these procedures whenever touching daemon or Collective UI code.

## Prerequisites

- Locate the daemon UI source: `packages/daemon/src/ui/` (or equivalent)
- Locate the Collective UI source: `packages/collective-ui/`
- Have a browser open for screenshot review before merging any visual changes
- Confirm ESLint is running with `react-hooks/exhaustive-deps` enabled and treated as an error
- Review the 6-theme system and theme CSS file organization in `packages/daemon/src/ui/styles/themes/`

## Procedure 1: Design System Token Integration

The daemon uses CSS custom properties for color, typography, and spacing. Never introduce custom color values — even one hardcoded hex breaks visual consistency across the surface.

### 6-Theme System

The design system includes **6 named themes**. Each theme has a unique primary color mapped to `--color-primary` and related accent/structural tokens. Ochre is reserved exclusively for the Collective UI and must not appear in daemon theme files.

**Available themes:**
- Sage (cool green, daemon default)
- Moss (saturated green)
- Terracotta (warm orange-red)
- Dusk (cool purple-blue)
- Plum (warm purple)
- Slate (neutral blue-gray)

**Ochre (Collective-only):** Do not reference or define `--color-ochre` in daemon theme CSS. This prevents visual bleed when the Collective is embedded.

### Palette tokens structure

Theme files are imported via PostCSS in `src/ui/styles/main.css`:

```css
/* CRITICAL: @import must precede @tailwind directives */
/* Otherwise theme CSS is silently dropped from the bundle (no build error) */
@import './themes/sage.css';
@import './themes/moss.css';
@import './themes/terracotta.css';
@import './themes/dusk.css';
@import './themes/plum.css';
@import './themes/slate.css';

/* @tailwind directives come AFTER theme imports */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

If `@tailwind` appears before theme `@import`, the theme CSS is discarded silently — no build warning, but the themes don't work at runtime.

### CSS cascade and specificity

Theme selectors must use `:root[data-theme="...\"]` (not bare `[data-theme="...\"]`) to match the specificity of `:root` baseline styles. A selector like `[data-theme="sage"]` has the same specificity as `:root`, and source-order becomes unpredictable — the last declaration wins, breaking theme switching.

```css
/* CORRECT — :root specificity */
:root[data-theme="sage"] {
  --color-primary: #4a7c59;
}

/* WRONG — same specificity as :root, source order wins */
[data-theme="sage"] {
  --color-primary: #4a7c59;
}
```

**Typography hierarchy** — three fonts, each with a distinct role:
- Display/heading font: large structural labels
- Body font: content and descriptions
- Mono font: code, IDs, config values

**Tonal layering**: backgrounds use tonal steps of the primary color or neutral grays — not flat white or arbitrary colors.

**Before writing any CSS in a new component:**
1. Read the daemon shell's theme files to inventory all current custom properties
2. Search for hardcoded values in your new file: `grep -rn "#[0-9a-fA-F]{3,6}|rgb(" src/your-surface/`
3. If a color isn't available as a daemon token, do not invent a new variable — decide whether the token belongs in the design system

Warm neutrals and ochre (`#brown`, beige tones, warm hex values, any use of `--color-ochre`) are the primary canary signals for design drift. See Procedure 3.

## Procedure 2: App Shell Grammar and Master-Detail Layout

Daemon UI pages follow a **master-detail layout**: a list/overview panel on the left, a detail/inspector panel on the right. Full-width cards or centered-column editorial layouts are incorrect for daemon pages.

**App shell components — extract, do not rebuild:**
- **Nav rail**: solid structural rail, left-anchored, no rounded "bubble" borders on nav items
- **Sidebar**: same structural treatment as the nav rail
- **Page shell wrapper**: consistent padding, title placement, content area

Do not rebuild the chrome from scratch when creating a new UI surface. Extract the daemon's shell primitives and compose your page inside them. Both times the Collective UI was rebuilt from scratch, the result required full visual rework because the structural language diverged.

**How to extract and reuse:**
1. Read the daemon's main layout component to identify shell primitives
2. Import those primitives into the new surface
3. Compose your page content inside the shell — do not recreate structural HTML

**Master-detail pattern:**
```
┌──────────────────────┬───────────────────────────┐
│  Left: list/overview │  Right: detail/inspector   │
└──────────────────────┴───────────────────────────┘
```
If your page renders a single centered column of cards, stop and re-evaluate the layout.

## Procedure 3: Canary Signal Detection and Design Drift Recovery

Design drift is detectable early via three canary signals. When any signal appears, **stop and audit before writing more code**.

**The three canary signals:**

| Signal | Correct | Wrong |
|--------|---------|----------|
| Color palette | Sage, moss, terracotta, dusk, plum, slate (via `--color-primary` theme variable); ochre only in Collective | Brown, warm neutrals, arbitrary hex values, ochre in daemon CSS |
| Navigation elements | Solid structural rail | Bubble-bordered or rounded nav pills |
| Base font size | Daemon density scale (tighter) | Large editorial scale |

**Detection — run both checks:**
```bash
# Should only see daemon tokens
grep -rn "var(--" src/your-surface/

# Should return nothing
grep -rn "#[0-9a-fA-F]{3,6}|ochre" src/your-surface/
```
Screenshot the live page and visually scan all three signals.

**Recovery procedure** (apply in order):

1. **List custom CSS variables** defined in the new surface's CSS files — any `--custom-var` not sourced from the daemon shell
2. **Replace each** with the daemon token equivalent (warm neutral → `--color-charcoal`, theme color → `--color-primary`, etc.)
3. **Identify rebuilt structural chrome** — find nav, sidebar, or shell HTML built from scratch in the new surface
4. **Replace** with extracted daemon shell components (see Procedure 2)
5. **Verify master-detail layout** — confirm the page uses the two-panel pattern, not a centered column
6. **Verify PostCSS @import ordering** — check `main.css` theme imports precede `@tailwind` directives
7. **Verify theme CSS specificity** — all theme selectors use `:root[data-theme="...\"]`
8. **Re-run detection** — grep + screenshot
9. **Screenshot review before merging** — do not merge without a visual comparison against the daemon design language

## Procedure 4: React Component Patterns

### useCallback dep completeness

Every `useCallback` and `useEffect` must list all captured state and prop variables in the dependency array. A missing dep causes stale-closure bugs where the callback holds an outdated value at call time.

```typescript
// WRONG — ignoreInGit is captured from state but not listed
const handleSave = useCallback(async () => {
  await saveConfig({ ignoreInGit });
}, []);  // ← stale closure: ignoreInGit is always the initial value

// CORRECT
const handleSave = useCallback(async () => {
  await saveConfig({ ignoreInGit });
}, [ignoreInGit]);  // ← dep listed; callback refreshes when value changes
```

ESLint's `react-hooks/exhaustive-deps` rule catches this automatically. Never disable it to silence a warning — fix the dependency array instead. This class of bug is invisible in unit tests but caught by Playwright (the API call posts the stale value).

### SectionSaveRow pattern

Config forms use per-section save, not a single form-wide submit. Each editable section ends with a `<SectionSaveRow>` that shows Save/Cancel only when the section has unsaved changes.

```tsx
<SectionSaveRow
  dirty={dirty}
  onSave={handleSave}
  onCancel={handleCancel}
/>
```

The `dirty` flag compares current form state to the last-saved value, not to the initially loaded value. This allows the user to reset to the last save without reloading the page.

### toFormState / dirty-check / builder pattern

Config pages follow a three-function pattern for state management:

```typescript
// 1. Load config → form state
function toFormState(config: MyConfig): FormState { ... }

// 2. Compute dirty flag
const dirty = !isEqual(formState, toFormState(savedConfig));

// 3. Build updated config for save — spread original FIRST, overlay form values
function formToConfig(original: MyConfig, form: FormState): MyConfig {
  return { ...original, ...form };
}
```

**Critical**: `formToConfig` must spread `original` before overlaying `form`. This preserves config fields not present in the form (server-managed fields, future fields the form doesn't know about). Reversing the order silently drops those fields from every save.

### ScopedField pattern — Personal vs. Team settings

When a setting can be scoped to Personal (machine-local) or Team (shared), use the `ScopedField` component pattern:

```tsx
<ScopedField
  label="Provider Model"
  scope={scope}  // 'personal' | 'team'
  onScopeChange={setScope}
  hint="Where this setting is stored"
>
  <ProviderModelSelector value={model} onChange={setModel} />
</ScopedField>
```

Each scoped field includes:
- **Personal pill** — a clickable label showing current scope (top-right of the field)
- **Scope menu** — on click, toggle between Personal and Team
- **Promote/reset semantics** — changing scope may promote a personal setting to team or reset team to personal

**Key behaviors:**
- When scope is "Team," the field is visually distinct (slightly different background or border)
- A button or dropdown on the field lets the user change scope; the field itself is read-only to the scope
- Saving a Team-scoped field syncs it across all machines in the team; Personal stays local

See Procedure 5 (Configuration Page Architecture) for how to surface scope toggles in the UI layout.

## Procedure 5: Configuration Page Architecture

### Dashboard page = status summary only

The dashboard page shows status and quick-glance information. It is not the configuration authority for complex features.

```
Dashboard widget:
  ✓ Status indicator (enabled/disabled, connected/disconnected)
  ✓ Key metric or last-updated time
  ✓ "Configure →" link to dedicated page
  ✗ Multi-step setup forms
  ✗ Agent-specific instructions
  ✗ Token input fields
```

### Dedicated config page

A feature deserves its own dedicated route (e.g., `/mcp-settings`) when it has:
- Multi-step setup (generate token → copy to agent → verify)
- Agent-specific instructions that vary by configuration
- Multiple independent config sections

**Registering a new dedicated page:**
1. Add a route entry in the daemon UI router config
2. Add a nav link in the appropriate nav section
3. Create the page component: `src/ui/pages/MyFeaturePage.tsx`
4. Apply master-detail layout (Procedure 2)
5. Use `SectionSaveRow` per editable section (Procedure 4)

### Token/secret reveal state consistency

When a page shows multiple sensitive fields (API tokens, secrets), all fields must share a single reveal/hide state — one `showTokens` boolean, not one state variable per field.

```typescript
// CORRECT — single toggle controls all fields
const [showTokens, setShowTokens] = useState(false);

// WRONG — divergent state; fields get out of sync
const [showToken1, setShowToken1] = useState(false);
const [showToken2, setShowToken2] = useState(false);
```

## Procedure 6: Playwright Smoke Test Authoring for Config UI

Every config UI form should have a Playwright smoke test that verifies the form doesn't silently discard or corrupt values.

### What to test

1. **Toggle state round-trip**: enable a toggle → save → reload → toggle is still enabled
2. **API POST with correct value**: intercept the save request and assert the payload contains the current form value (not a stale/default value — this is the `useCallback` dep bug in production)
3. **Visual state consistency**: verify the UI reflects the saved state after reload (badge, token field, status indicator)
4. **Computed style verification**: check that CSS theme values are applied at runtime, not just that files exist

### Test structure

```typescript
test('config toggle round-trips correctly', async ({ page }) => {
  await page.goto('/mcp-settings');

  // Capture the outgoing save request
  const [request] = await Promise.all([
    page.waitForRequest(
      req => req.url().includes('/api/config') && req.method() === 'POST'
    ),
    page.click('[data-testid="ignore-in-git-toggle"]'),
    page.click('[data-testid="save-section"]'),
  ]);

  const body = request.postDataJSON();
  expect(body.ignoreInGit).toBe(true);  // not the stale pre-toggle value

  // Verify UI reflects saved state after reload
  await page.reload();
  await expect(
    page.locator('[data-testid="ignore-in-git-toggle"]')
  ).toBeChecked();
});

// CSS verification — check theme colors are applied at runtime
test('theme CSS is applied and renders correctly', async ({ page }) => {
  await page.goto('/mcp-settings?theme=sage');
  
  const primaryElement = page.locator('[data-testid="primary-color-swatch"]');
  const computedColor = await primaryElement.evaluate(
    (el) => getComputedStyle(el).backgroundColor
  );
  
  // Verify the computed style matches the theme (not a fallback or error state)
  expect(computedColor).toMatch(/rgb\(\d+,\s*\d+,\s*\d+\)/);
  // Do not test exact hex values; test that a color is computed
});
```

### Wire to CI

Add the spec file to the Playwright config's `testDir`. Run locally:
```bash
npx playwright test path/to/config-ui.spec.ts
```

### What Playwright catches that unit tests miss

- **`useCallback` dep bugs** — the API call posts the stale pre-toggle value; unit tests mock the call and never see the staleness
- **`formToConfig` field-drop bugs** — the saved payload is missing fields; only caught by inspecting the actual POST body
- **State-after-reload inconsistencies** — save returns 200 but the UI doesn't reflect it on reload
- **CSS bundle gaps** — the theme CSS file exists but `@import` ordering is wrong or specificity is broken, so computed styles are fallback values

## Procedure 7: Appearance Configuration UI and Settings Forms

Config pages with collapsible sections and multi-field layouts must follow specific patterns to maintain consistency across the daemon.

### Collapsible section UX

When a config page has many sections, implement collapsible sections to reduce visual density and focus. The collapsible behavior differs by section type:

**Sidebar sections that collapse to icon-only:**
- Each sidebar nav item can collapse to show only an icon (typically the first character or a symbol)
- On hover of the collapsed icon, show a tooltip with the full section name
- Use `localStorage` to persist the collapsed/expanded state for UX continuity across page reloads
- Do NOT use the daemon's main config file to store UI layout state — this is an ephemeral, machine-local preference

**Content sections that fully hide:**
- For non-sidebar content sections (e.g., "Appearance" settings), when collapsed, the entire section content hides — no compact icon state
- Expand/collapse is controlled by a clickable header or chevron button
- The section title remains visible even when collapsed
- State is persisted to `localStorage` under a key like `section-visibility-<sectionName>`

**localStorage ephemeral state exception:**
Unlike config values (which go to the vault or shared project file), UI layout state (collapsed sections, revealed tokens, form scroll position) should use browser `localStorage`. This is a documented exception to the "all state in config files" rule.

```typescript
// Ephemeral UI state — use localStorage
const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
  return localStorage.getItem('sidebar-collapsed') === 'true';
});

const handleCollapse = useCallback((collapsed: boolean) => {
  setSidebarCollapsed(collapsed);
  localStorage.setItem('sidebar-collapsed', collapsed.toString());
}, []);
```

### Section kebab menu (batch actions)

When a config section has multiple fields that can be overridden or reset, expose a "kebab" menu (three-dot `⋮` button) next to the section title with these options:

**Batch promote to project defaults:**
- "Promote all to project defaults" action
- When clicked, copy all current Personal (machine-local) settings in this section to the Team/project scope
- Shows a confirmation: "This will update Team settings for 4 fields"
- After promotion, the fields visually transition to Team scope (e.g., different background or icon)

**Reset all to defaults:**
- "Reset all to defaults" action
- Clears all overrides in the section back to the project defaults
- Only appears if at least one field differs from the defaults
- Confirmation: "This will reset 3 fields to project defaults. This cannot be undone."

**Implementation:**
```tsx
function SectionKebabMenu({ 
  fields,  // array of {name, isOverridden, isTeamScope}
  onPromoteAll,
  onResetAll,
}) {
  const overriddenCount = fields.filter(f => f.isOverridden).length;
  const isAnyLocal = fields.some(f => !f.isTeamScope);
  
  return (
    <Dropdown>
      {isAnyLocal && (
        <MenuItem 
          onClick={() => onPromoteAll()}
        >
          Promote all to project defaults ({overriddenCount})
        </MenuItem>
      )}
      {overriddenCount > 0 && (
        <MenuItem 
          onClick={() => onResetAll()}
          appearance="danger"
        >
          Reset all to defaults
        </MenuItem>
      )}
    </Dropdown>
  );
}
```

## Procedure 8: Configuration Migration and I/O Optimization

When evolving a config surface (e.g., moving settings from localStorage to persisted config files), follow these patterns to maintain data integrity and optimize performance.

### localStorage → file migration procedure

When a feature stored settings in browser `localStorage` and now must move to persistent config files (vault or project file):

**Idempotent migration design:**
1. On first page load, check if `localStorage` has the old keys: `appearance.theme`, `appearance.density`, `appearance.fontSize`, `appearance.syncTheme`
2. If found, read them and merge into the current config state
3. Immediately write the merged config to the persistent store via the normal save endpoint
4. Add a cleanup TODO comment with a deadline: `// TODO(2026-04-30): Remove localStorage migration code`
5. Do NOT set a sentinel flag (like `migrationComplete: true`) in config — the deadline comment is sufficient

**Why not a sentinel flag?**
- A flag in config becomes a permanent part of the codebase
- If the migration logic is removed (see cleanup deadline), the flag is orphaned
- Deadline comments are self-documenting and easily grep-able for cleanup

**Implementation:**
```typescript
// Load existing config first
const [config, setConfig] = useState(loadedConfig);

useEffect(() => {
  // Check for and migrate localStorage settings
  const oldTheme = localStorage.getItem('appearance.theme');
  const oldDensity = localStorage.getItem('appearance.density');
  const oldFontSize = localStorage.getItem('appearance.fontSize');
  const oldSyncTheme = localStorage.getItem('appearance.syncTheme');

  if (oldTheme || oldDensity || oldFontSize || oldSyncTheme) {
    const migratedConfig = {
      ...config,
      appearance: {
        ...config.appearance,
        ...(oldTheme && { theme: oldTheme }),
        ...(oldDensity && { density: oldDensity }),
        ...(oldFontSize && { fontSize: oldFontSize }),
        ...(oldSyncTheme && { syncTheme: oldSyncTheme === 'true' }),
      },
    };

    // Save the migrated config to persistent store
    saveConfig(migratedConfig);
    setConfig(migratedConfig);

    // Clear the old localStorage keys
    localStorage.removeItem('appearance.theme');
    localStorage.removeItem('appearance.density');
    localStorage.removeItem('appearance.fontSize');
    localStorage.removeItem('appearance.syncTheme');

    // TODO(2026-04-30): Remove this migration block entirely
  }
}, []);
```

### I/O optimization patterns

Config pages often perform frequent reads and writes. Apply these patterns to avoid redundant requests and DOM mutations:

**Skip write when content unchanged:**
- Before calling the save endpoint, compare the form state to the last-saved config
- If they are identical, do not make the POST request
- This is already handled by the `dirty` flag (Procedure 4), but verify in your `onSave` handler:

```typescript
const handleSave = useCallback(async () => {
  if (!dirty) {
    console.log('No changes; skipping save');
    return;
  }
  await saveConfig(formToConfig(savedConfig, formState));
}, [dirty, formState, savedConfig]);
```

**useMemo for appearance context on primitive keys:**
- When creating a context for appearance settings (theme, density, font size), memoize the context value by primitive fields, not by object reference
- Without memoization, every render creates a new object, causing all consumers to re-render unnecessarily

```typescript
// WRONG — new object on every render
const appearanceValue = {
  theme: currentTheme,
  density: currentDensity,
  fontSize: currentFontSize,
};

// CORRECT — memoized on primitive field values
const appearanceValue = useMemo(() => ({
  theme: currentTheme,
  density: currentDensity,
  fontSize: currentFontSize,
}), [currentTheme, currentDensity, currentFontSize]);
```

**Guard DOM mutation before setAttribute/favicon href swap:**
- When updating the favicon or applying theme CSS via DOM manipulation, check the current value before mutating
- Unnecessary mutations can trigger page reflows and layout thrashing

```typescript
const updateFavicon = useCallback((theme: string) => {
  const faviconLink = document.querySelector('link[rel="icon"]');
  if (!faviconLink) return;

  const newHref = `/favicons/theme-${theme}.svg`;
  
  // Guard: only mutate if href actually changed
  if (faviconLink.getAttribute('href') !== newHref) {
    faviconLink.setAttribute('href', newHref);
  }
}, []);
```

**Single loadConfig() in HTTP handlers:**
- When a page has multiple sections that each call the config endpoint, consolidate to a single `loadConfig()` call in the page-level effect
- Pass the full config down to child sections as props; do not have each section independently fetch config
- Reduces request count and keeps config state synchronized across the page

```typescript
// Page-level: fetch once
const [config, setConfig] = useState(null);

useEffect(() => {
  loadConfig().then(setConfig);
}, []);

// Child section receives config as prop
<AppearanceSection config={config} onSave={handleSave} />
<NotificationSection config={config} onSave={handleSave} />
```

## Cross-Cutting Gotchas

- **Warm neutral ≠ neutral** — in the daemon design system, "neutral" is charcoal-based. Brown/beige tones immediately signal a design system mismatch. Ochre in daemon CSS is also a canary for Collective UI code bleeding into daemon.
- **PostCSS @import ordering is silent** — if theme `@import` statements appear AFTER `@tailwind`, the theme CSS is discarded silently. No build error, no warning. The only symptom is missing theme colors at runtime. Check `main.css` import order if themes don't render.
- **CSS specificity requires `:root[data-theme="...\"]`** — bare `[data-theme="...\"]` has the same specificity as `:root`, causing source-order nondeterminism. Always use `:root[data-theme="...\"]`.
- **Collective UI is a separate package but must inherit daemon design language** — it has its own deployment (`oss.goondocks.workers.dev`) but is not a separate visual system. Use `make collective-ui-dev` for a local proxy against live worker settings.
- **ESLint hooks rule is your first line of defence** — never suppress `react-hooks/exhaustive-deps`. The warning is the bug report.
- **Screenshot before merging** — visual consistency is the primary review signal for daemon UI. A screenshot comparison catches design drift that code review misses.
- **`formToConfig` spread order is silent** — there is no runtime error when you get the spread order wrong. The only symptom is data loss in production. Test it with Playwright.
- **Favicon-per-theme SVG switching** — the daemon renders 6 pre-generated SVG favicon variants (one per theme). At runtime, on theme change, the UI updates `<link rel="icon" href={faviconForTheme(theme)} />` to swap the favicon. The SVG files must exist in `public/favicons/theme-{name}.svg`. Missing SVG files show the fallback browser favicon (not an error).
- **Dynamic page title pattern** — the page title follows the format `Myco — <project-name>`, sourced from the loaded `myco.yaml` config. Multiple local instances of Myco (different projects) must have distinct titles in browser tabs. If the title is not populated, check that `projectName` is loaded from config before rendering the page shell.
- **RedactedField copy-button gotcha** — when displaying a masked token (e.g., `***`), the `<CopyButton>` component must receive the real token value, not the `displayValue`. Passing `displayValue` results in copying `***` to the clipboard. Correct usage: `<CopyButton value={realToken} />` with the button rendering the masked display separately.
- **localStorage for UI state is ephemeral-only** — collapse/expand state, revealed token visibility, form scroll position belong in `localStorage`. Config values, team settings, and anything that should sync across machines belong in the vault or project config file. Never conflate the two.
- **Cleanup deadline comments instead of sentinel flags** — when migrating data from one storage to another (localStorage → file), use TODO comments with deadlines, not sentinel config flags. Flags become orphaned when cleanup code is removed.
