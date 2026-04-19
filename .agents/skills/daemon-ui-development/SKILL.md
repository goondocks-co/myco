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
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob]
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

## Procedure 5: Mycelium UI Patterns — Session and Spore Management

**Location:** `packages/daemon/src/ui/pages/Mycelium.tsx`

The Mycelium (vault) UI follows specific patterns for session browsing, spore management, and lineage visualization. Always preserve these interaction patterns when extending functionality.

### Session List Interaction
- **Pagination:** Use cursor-based pagination with "Load More" pattern, not numbered pages
- **Status filtering:** Active sessions at top, terminal sessions below with clear visual separation
- **Title truncation:** Session titles truncate at container width with hover tooltip for full text
- **Status indicators:** Use consistent badge patterns for active/terminal states with color coding

### Spore Grid Layout
```typescript
// Standard spore grid with responsive columns
<div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
  {spores.map(spore => (
    <SporeCard key={spore.id} spore={spore} />
  ))}
</div>
```

**Spore importance visual hierarchy:** Use color intensity to indicate importance (1-3: muted, 4-6: normal, 7-10: emphasized). Never use font size variation for importance — it breaks grid alignment.

### Lineage Visualization Patterns
- **Edge types:** Use distinct visual styles for different lineage relationships (FROM_SESSION, EXTRACTED_FROM, HAS_BATCH, DERIVED_FROM)
- **Node clustering:** Group related nodes by session or observation type to reduce visual complexity
- **Interactive exploration:** Implement click-to-expand patterns for deep lineage walks rather than showing all edges at once

### Search and Filter Integration
```typescript
// Unified search pattern across Mycelium sections
const [searchQuery, setSearchQuery] = useState('');
const [filters, setFilters] = useState({ type: 'all', status: 'active' });

// Debounced search to avoid excessive API calls
const debouncedSearch = useMemo(
  () => debounce((query: string) => {
    // Trigger search API call
  }, 300),
  []
);
```

## Procedure 9: Notification Domains — Four-Domain System

**Notification domains** organize emission points across four Myco subsystems:

| Domain | Subsystem | Examples |
|--------|-----------|----------|
| plan | Intelligence task execution | Skill updates, digest generation |
| daemon | Daemon server operations | Config writes, MCP errors |
| team | Team sync and Collective | Token rotation, sync status |
| **settings** | **UI-specific events** | **Config validation, scope conflicts, restart notices** |

**New (gen 12):** The `settings` domain consolidates UI-specific notifications previously mixed into other domains. Use `settings` for field-level validation, scope conflict warnings, daemon restart notices, and theme feedback.

### Notification Banner Positioning Logic
```typescript
// Banner positioning must account for panel state
const bannerOffset = useMemo(() => {
  if (focusedPanel === 'mcp' || focusedPanel === 'team') {
    return '320px'; // Panel width + margin
  }
  return '0px';
}, [focusedPanel]);
```

## Procedure 10: MCP Schema Validation and Error Display

**MCP schema violations** require specific error handling patterns in the UI. Never show raw schema validation errors to users — they contain internal field names and confuse non-technical users.

### Error Message Translation Pattern
```typescript
// Transform MCP schema errors into user-friendly messages
const translateMcpError = (error: McpValidationError): string => {
  if (error.path.includes('serverName')) {
    return 'Server name is required and must be unique';
  }
  if (error.path.includes('command')) {
    return 'Command path must be a valid file path';
  }
  if (error.path.includes('args')) {
    return 'Arguments must be valid command line options';
  }
  if (error.path.includes('env')) {
    return 'Environment variables must follow KEY=value format';
  }
  // Fallback for unknown errors
  return 'Configuration contains invalid values. Please review your settings.';
};
```

**Form validation timing:** Validate MCP schemas on blur, not on change. Change-based validation creates too much visual noise as users type paths and commands.

**Error placement:** Schema errors appear directly below the affected field, not in a global error banner. This creates better spatial association between error and source.

### MCP Server Configuration Patterns
```typescript
// Standard MCP server config form structure
interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

// Validation rules for each field
const validateMcpServer = (config: McpServerConfig) => {
  const errors: Record<string, string> = {};
  
  if (!config.name.trim()) {
    errors.name = 'Server name is required';
  }
  
  if (!config.command.trim()) {
    errors.command = 'Command path is required';
  } else if (!isValidFilePath(config.command)) {
    errors.command = 'Must be a valid file path';
  }
  
  return errors;
};
```

## Test Patterns and Improvement Guidelines

### Playwright Test Structure
```typescript
// Standard page navigation test pattern
test('navigates to mycelium page', async ({ page, daemon }) => {
  await daemon.goto('/');
  await page.click('[data-testid="nav-mycelium"]');
  await expect(page).toHaveURL(/\/mycelium$/);
  await expect(page.locator('h1')).toHaveText('Mycelium');
});

// Improved error handling and retries
test('handles API errors gracefully', async ({ page, daemon }) => {
  // Mock network failure
  await page.route('**/api/vault/**', (route) => {
    route.fulfill({ status: 500, body: 'Server Error' });
  });
  
  await daemon.goto('/mycelium');
  
  // Verify error state UI
  await expect(page.locator('[data-testid="error-banner"]')).toBeVisible();
  await expect(page.locator('[data-testid="retry-button"]')).toBeVisible();
});
```

**Test stability improvements:**
- Always use `data-testid` selectors, never CSS classes or text content
- Wait for network idle before assertions: `await page.waitForLoadState('networkidle')`
- Use explicit waits for dynamic content: `await expect(element).toBeVisible({ timeout: 5000 })`
- Add retry mechanisms for flaky interactions: `await page.click(selector, { timeout: 10000, force: true })`

### Vitest Component Testing
```typescript
// Mock MCP responses for reliable component tests
const mockMcpResponse = {
  servers: [{ name: 'test-server', command: '/path/to/server' }]
};

beforeEach(() => {
  vi.mocked(mcpClient.listServers).mockResolvedValue(mockMcpResponse);
});

// Test component isolation with proper cleanup
afterEach(() => {
  vi.clearAllMocks();
  cleanup(); // React Testing Library cleanup
});
```

### Integration Test Patterns
```typescript
// Test full user workflows end-to-end
test('skill lifecycle from candidate to generation', async ({ page, daemon }) => {
  // Navigate to skills page
  await daemon.goto('/skills');
  
  // Create candidate
  await page.click('[data-testid="create-candidate"]');
  await page.fill('[data-testid="topic-input"]', 'Test Skill');
  await page.fill('[data-testid="rationale-input"]', 'Testing workflow');
  await page.click('[data-testid="submit-candidate"]');
  
  // Approve candidate
  await page.click('[data-testid="approve-candidate"]');
  
  // Verify staging workflow
  await expect(page.locator('[data-testid="staging-indicator"]')).toBeVisible();
});
```

## Cross-Cutting Gotchas

- **Closure factory ref-container mutation gotcha:** When using a closure to manage ref state, use `{ current: value }` structure, not direct binding. Direct binding causes mutations to be invisible to observers, especially in tests checking ref.current.
- **focus.ts is the coordination layer:** All panel open/close and banner positioning must flow through `setFocusedPanel()`. Bypassing this with direct useState setters desynchronizes banner position and breaks deep-link navigation.
- **Notification banner z-index exceeds panel stacking context:** Banner must have higher z-index than settings panel to remain visible. Verify with DevTools when adjusting panel stacking order.
- **ScopedField renders passive Project scope pill:** When Team scope differs from Project scope, the Team option displays a distinct pill. Do not customize this rendering; it's a layout constraint for consistency.
- **MCP schema error translation required:** Never show raw schema validation messages to users. Always translate error paths to user-friendly field descriptions.
- **Spore importance uses color, not size:** Visual hierarchy through color intensity only. Font size variation breaks responsive grid layout.
- **Debounce search inputs:** All search/filter inputs should be debounced (300ms) to prevent excessive API calls while typing.
- **Cursor-based pagination for large datasets:** Use "Load More" pattern instead of numbered pages for sessions and spores to handle potentially large result sets efficiently.