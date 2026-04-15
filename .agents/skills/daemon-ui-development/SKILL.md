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
  ScopedField with useScopedConfig, write-on-blur, DotPaths<T>, atomic
  multi-field writes), config page architecture with collapsible sections and
  kebab menus, localStorage migration, I/O optimization, Playwright tests,
  favicon switching, title pattern, AppearanceProvider constraints, Vitest
  fixtures, RedactedField gotcha, hard-refresh gotcha. Activates whenever
  building daemon UI or reviewing components for visual compliance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Daemon UI Development

The Myco daemon UI has deliberate design language, layout patterns, and configuration system. Deviating from established patterns causes rework.

## Procedure 4b: focus.ts Coordination Layer — Panel State and Banner Positioning

**Location:** `packages/daemon/src/ui/state/focus.ts`

The focus state atom is the **single source of truth** for panel state, notification banner positioning, and deep-link navigation. All panel open/close operations must flow through `setFocusedPanel()`. Never bypass this by calling `useState` setters directly — doing so desynchronizes the banner position and breaks deep-link config navigation.

```typescript
// CORRECT — uses the coordination layer
const { focusedPanel, setFocusedPanel } = useFocus();
const handleOpenSettings = useCallback(() => {
  setFocusedPanel('mcp');  // Panel opens AND banner repositions atomically
}, [setFocusedPanel]);

// WRONG — bypasses coordination
const [isOpen, setIsOpen] = useState(false);
const handleOpenSettings = () => {
  setIsOpen(true);  // Banner doesn't reposition
};
```

**Deep-link navigation pattern:** Config sections are deep-linkable via query params (`?configSection=mcp&configField=serverName`). Always construct links from the focus state API, never as hardcoded strings.

### Notification Banner Z-Index Constraint

When settings panels open and the notification banner moves, ensure the banner's z-index **exceeds** the settings panel's stacking context. A settings panel with `z-index: 30` and banner `z-index: 20` results in the banner being hidden behind the panel — a silent visual bug.

**Z-index hierarchy (from bottom to top):**
1. Page content: `z-index: auto` (default)
2. Settings panel: `z-index: 30`
3. Notification banner: `z-index: 40` or higher

Always verify banner visibility when adjusting panel stacking context.

## Procedure 9: Notification Domains — Four-Domain System

**Notification domains** organize emission points across four Myco subsystems:

| Domain | Subsystem | Examples |
|--------|-----------|----------|
| plan | Intelligence task execution | Skill updates, digest generation |
| daemon | Daemon server operations | Config writes, MCP errors |
| team | Team sync and Collective | Token rotation, sync status |
| **settings** | **UI-specific events** | **Config validation, scope conflicts, restart notices** |

**New (gen 12):** The `settings` domain consolidates UI-specific notifications previously mixed into other domains. Use `settings` for field-level validation, scope conflict warnings, daemon restart notices, and theme feedback.

## Cross-Cutting Gotchas

- **Closure factory ref-container mutation gotcha:** When using a closure to manage ref state, use `{ current: value }` structure, not direct binding. Direct binding causes mutations to be invisible to observers, especially in tests checking ref.current.
- **focus.ts is the coordination layer:** All panel open/close and banner positioning must flow through `setFocusedPanel()`. Bypassing this with direct useState setters desynchronizes banner position and breaks deep-link navigation.
- **Notification banner z-index exceeds panel stacking context:** Banner must have higher z-index than settings panel to remain visible. Verify with DevTools when adjusting panel stacking order.
- **ScopedField renders passive Project scope pill:** When Team scope differs from Project scope, the Team option displays a distinct pill. Do not customize this rendering; it's a layout constraint for consistency.
