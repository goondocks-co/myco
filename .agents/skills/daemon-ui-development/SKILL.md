---
name: myco:daemon-ui-development
description: |
  Use when building, extending, or reviewing any page or component in the
  Myco daemon web UI or Collective UI — even if the user doesn't explicitly
  ask about design compliance or testing. Covers: design system token
  integration (sage/ochre/terracotta CSS custom properties, three-font
  hierarchy, tonal layering), app shell grammar and master-detail layout
  enforcement, canary signal detection and design drift recovery, React
  component patterns (useCallback dep completeness, SectionSaveRow,
  toFormState/dirty-check/builder pattern), configuration page architecture
  separation (dashboard=status summary vs. dedicated config page), Playwright
  smoke test authoring for config UI forms, and new page registration.
  Activates whenever creating a new daemon UI page, reviewing components for
  visual compliance, writing Playwright tests for config forms, or debugging
  stale-closure bugs in React hooks.
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

## Procedure 1: Design System Token Integration

The daemon uses CSS custom properties for color, typography, and spacing. Never introduce custom color values — even one hardcoded hex breaks visual consistency across the surface.

**Palette tokens** (set at the daemon shell level):
```css
--color-sage         /* primary structural green */
--color-ochre        /* accent / highlight */
--color-terracotta   /* warning / action */
--color-charcoal     /* text and structure */
```

**Typography hierarchy** — three fonts, each with a distinct role:
- Display/heading font: large structural labels
- Body font: content and descriptions
- Mono font: code, IDs, config values

**Tonal layering**: backgrounds use tonal steps of `--color-sage` or charcoal-based neutrals — not flat white or arbitrary grays.

**Before writing any CSS in a new component:**
1. Read the daemon shell's main CSS file to inventory all current custom properties
2. Search for hardcoded values in your new file: `grep -rn "#[0-9a-fA-F]\{3,6\}\|rgb(" src/your-surface/`
3. If a color isn't available as a daemon token, do not invent a new variable — decide whether the token belongs in the design system

Warm neutrals (`#brown`, beige tones, warm hex values) are the primary canary signal for design drift. See Procedure 3.

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
|--------|---------|-------|
| Color palette | Sage, ochre, terracotta, charcoal | Brown, warm neutrals, arbitrary hex values |
| Navigation elements | Solid structural rail | Bubble-bordered or rounded nav pills |
| Base font size | Daemon density scale (tighter) | Large editorial scale |

**Detection — run both checks:**
```bash
# Should only see daemon tokens
grep -rn "var(--" src/your-surface/

# Should return nothing
grep -rn "#[0-9a-fA-F]\{3,6\}" src/your-surface/
```
Screenshot the live page and visually scan all three signals.

**Recovery procedure** (apply in order):

1. **List custom CSS variables** defined in the new surface's CSS files — any `--custom-var` not sourced from the daemon shell
2. **Replace each** with the daemon token equivalent (warm neutral → `--color-charcoal`, green → `--color-sage`, etc.)
3. **Identify rebuilt structural chrome** — find nav, sidebar, or shell HTML built from scratch in the new surface
4. **Replace** with extracted daemon shell components (see Procedure 2)
5. **Verify master-detail layout** — confirm the page uses the two-panel pattern, not a centered column
6. **Re-run detection** — grep + screenshot
7. **Screenshot review before merging** — do not merge without a visual comparison against the daemon design language

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

## Cross-Cutting Gotchas

- **Warm neutral ≠ neutral** — in the daemon design system, "neutral" is charcoal-based. Brown/beige tones immediately signal a design system mismatch.
- **Collective UI is a separate package but must inherit daemon design language** — it has its own deployment (`oss.goondocks.workers.dev`) but is not a separate visual system. Use `make collective-ui-dev` for a local proxy against live worker settings.
- **ESLint hooks rule is your first line of defence** — never suppress `react-hooks/exhaustive-deps`. The warning is the bug report.
- **Screenshot before merging** — visual consistency is the primary review signal for daemon UI. A screenshot comparison catches design drift that code review misses.
- **`formToConfig` spread order is silent** — there is no runtime error when you get the spread order wrong. The only symptom is data loss in production. Test it with Playwright.
