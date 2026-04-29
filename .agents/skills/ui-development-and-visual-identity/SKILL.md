---
name: myco:ui-development-and-visual-identity
description: |
  Comprehensive procedures for building, maintaining, and extending Myco's React-based UI components and multi-instance visual identity system. Covers React component architecture patterns, theme system implementation with 6-theme variants, multi-instance visual coordination for daemon/collective/marketing distinction, frontend build integration, appearance controls, and component development lifecycle. Use when implementing new UI components, extending the theme system, coordinating visual identity across multiple Myco instances, or troubleshooting frontend build issues, even if the user doesn't explicitly ask for UI development guidance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# UI Development and Visual Identity System

Myco's UI spans multiple contexts (daemon, collective, marketing) that must maintain family cohesion while providing visual distinction. The system uses a 6-theme architecture with dynamic configuration, React component patterns optimized for multi-instance coordination, and integrated build tooling.

## Prerequisites

- Myco project with `.myco/` vault directory
- Node.js environment with npm workspaces
- Access to `packages/myco/ui/` and related UI directories
- Understanding of Myco's config overlay pattern (`.myco/local.yaml` over `myco.yaml`)

## Procedure A: React Component Architecture Patterns

### Multi-Instance Component Design

Design components that work across daemon, collective, and marketing contexts:

```typescript
// Use context providers for instance-aware behavior
const InstanceContext = createContext<'daemon' | 'collective' | 'marketing'>()

// Component adapts behavior based on instance
function NavigationComponent() {
  const instance = useContext(InstanceContext)
  const baseClasses = "nav-component"
  const instanceClasses = instance === 'collective' ? 'nav-collective' : 'nav-daemon'
  
  return <nav className={`${baseClasses} ${instanceClasses}`}>
    {/* Instance-specific navigation items */}
  </nav>
}
```

### State Management Across Contexts

Use local state for UI preferences, context for instance coordination:

```typescript
// Local state for user preferences
const [appearance, setAppearance] = useState({
  theme: 'sage',
  fontSize: 'medium',
  density: 'comfortable',
  darkMode: false
})

// Context for cross-component coordination
const AppearanceContext = createContext<AppearanceState>()
```

### Component Composition Strategy

Build reusable primitives that compose into domain-specific components:

```
Base Components (packages/myco/ui/src/components/)
├── Button, Input, Card, Modal
└── Theme-aware, instance-agnostic

Domain Components (packages/myco/ui/src/components/domains/)
├── settings/, dashboard/, auth/
└── Composed from base, domain-specific logic

Pages (packages/myco/ui/src/pages/)
├── Settings, Dashboard, Cortex
└── Uses domain components, adds layout context
```

### Hub Base-Path Routing Integration

Handle base-path routing for hub-proxied daemon UIs through `__MYCO_HUB_PREFIX__` detection:

```typescript
// Detect hub context and configure router base-path
function detectHubBasePrefix(): string {
  // Check if running inside hub proxy iframe
  if (window !== window.top) {
    // Extract base path from hub URL pattern: /p/<project-id>/
    const hubPrefix = (window as any).__MYCO_HUB_PREFIX__;
    if (hubPrefix) {
      return hubPrefix;
    }
  }
  
  // Default to root for standalone daemon
  return '/';
}

// Configure React Router with dynamic base
<BrowserRouter basename={detectHubBasePrefix()}>
  <Routes>
    {/* App routes */}
  </Routes>
</BrowserRouter>
```

**Hub compatibility pattern**: Pre-#161 daemon versions lack `__MYCO_HUB_PREFIX__` detection, causing routing mismatches when served through hub proxy. Ensure daemon version compatibility or provide fallback routing.

## Procedure B: Theme System Implementation and Extension

### Core Theme Architecture

The 6-theme system uses CSS custom properties with color coordination:

```css
/* Base theme structure in packages/myco/ui/src/themes/ */
:root[data-theme="sage"] {
  --primary: #abcfb8;           /* Primary brand color */
  --on-primary: #163627;        /* Text on primary */
  --primary-container: #7b9e89; /* Container variant */
  --on-primary-container: #143525;
  
  --secondary: #edbf7f;         /* Supporting accent */
  --on-secondary: #442b00;
  --secondary-container: #60410b;
  
  --tertiary: #ffb4a1;          /* Third accent level */
  --on-tertiary: #5d1806;
  --tertiary-container: #df7a60;
}
```

### Adding New Themes

1. **Create theme definition file**:
```bash
# Create new theme file
touch packages/myco/ui/src/themes/ocean.css

# Follow naming pattern: ocean.css for "ocean" theme
```

2. **Define color palette**:
```css
:root[data-theme="ocean"] {
  /* Primary brand color family */
  --primary: #0ea5e9;
  --on-primary: #ffffff;
  --primary-container: #0284c7;
  --on-primary-container: #ffffff;
  
  /* Supporting colors */
  --secondary: #64748b;
  --on-secondary: #ffffff;
  --secondary-container: #475569;
  
  --tertiary: #06b6d4;
  --on-tertiary: #ffffff;
  --tertiary-container: #0891b2;
}

:root[data-theme="ocean"].light {
  /* Light mode variants if needed */
  --primary: #0369a1;
  --on-primary: #ffffff;
  /* ... additional light mode adjustments */
}
```

3. **Register in theme configuration**:
```typescript
// Update packages/myco/src/config/appearance-values.ts
export const APPEARANCE_THEMES = [
  'sage', 'moss', 'terracotta', 'dusk', 'plum', 'slate', 'ocean'
] as const;
```

4. **Add CSS import**:
```css
/* Update packages/myco/ui/src/index.css */
@import './themes/ocean.css';
```

### Reserved Color Coordination

**Ochre is reserved for Collective instances** to maintain visual distinction:
- Daemon instances: Use any of the 6 main themes
- Collective instances: Always use ochre accent colors
- Marketing site: Typically sage or theme-neutral

## Procedure C: Multi-Instance Visual Identity Coordination

### Dynamic Tab Title Generation

Generate distinct browser tab titles that identify both project and instance type:

```typescript
// In daemon initialization
function generateDynamicTitle(projectConfig: MycoConfig): string {
  const projectName = projectConfig.project?.name || 'Myco Project'
  const instanceType = 'Daemon' // or 'Collective', 'Marketing'
  
  return `${projectName} | Myco ${instanceType}`
}

// Update document title
document.title = generateDynamicTitle(config)
```

### Favicon Variant System

Use theme-coordinated favicons to provide visual distinction across tabs:

```typescript
// Favicon selection logic
function selectFavicon(theme: string, instance: 'daemon' | 'collective'): string {
  if (instance === 'collective') {
    return '/assets/favicons/collective-ochre.ico'
  }
  
  return `/assets/favicons/daemon-${theme}.ico`
}

// Update favicon dynamically
function updateFavicon(theme: string, instance: string) {
  const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement
  link.href = selectFavicon(theme, instance)
}
```

### Family Cohesion vs Instance Recognition

Balance unified Myco identity with practical tab distinction:

**Family cohesion**:
- Consistent typography (same font stack across instances)
- Shared component design language
- Common interaction patterns

**Instance recognition**:
- Theme-based color distinction (daemon themes vs collective ochre)
- Dynamic tab titles with project context
- Instance-specific favicon variants
- Contextual navigation differences

## Procedure D: Frontend Build Integration

### Vite Asset Pipeline Integration

Configure Vite for monorepo structure with theme asset coordination:

```typescript
// vite.config.ts pattern for UI packages
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs']
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM'
        }
      }
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Theme variable imports
        additionalData: `@import "src/themes/variables.scss";`
      }
    }
  }
})
```

### Bundle Caching Gotchas

**Development cache issues**: Hard refresh required when:
- Theme CSS files change
- CSS custom properties are added/modified
- Asset imports change (favicons, fonts)

```bash
# Force cache clear during theme development
rm -rf node_modules/.vite
npm run dev
```

**Production bundle coordination**: Ensure theme assets are properly included:

```typescript
// Explicit asset imports to ensure bundling (in packages/myco/ui/src/index.css)
@import './themes/_shared-accents.css';
@import './themes/sage.css';
@import './themes/moss.css';
@import './themes/terracotta.css';
@import './themes/dusk.css';
@import './themes/plum.css';
@import './themes/slate.css';
```

### CSS Variable Coordination

Coordinate CSS custom properties across theme files and component stylesheets:

```css
/* Component CSS uses semantic variables */
.button-primary {
  background-color: var(--primary);
  color: var(--on-primary);
  border: 1px solid var(--primary-container);
}

/* Never hardcode theme colors in components */
/* ❌ Bad: background-color: #abcfb8; */
/* ✅ Good: background-color: var(--primary); */
```

### Worktree Build Environment Setup

Git worktrees require independent UI workspace installation for proper builds:

```bash
# After creating a worktree, install nested UI dependencies
cd .worktrees/feature-branch-name

# Root install doesn't cover nested UI workspaces
npm install

# Install each nested UI workspace separately  
cd packages/myco/ui && npm install
cd ../../myco-hub/ui && npm install

# Now build commands work correctly
npm run build:ui
```

**Critical gotcha**: The monorepo root `npm install` does not install dependencies for nested UI workspaces in worktrees. Each `packages/*/ui` workspace needs its own `npm install` run.

## Procedure E: Appearance Controls and User Preferences

### Configuration Overlay Pattern

Store appearance preferences in `.myco/local.yaml` for personal overrides:

```yaml
# .myco/local.yaml (personal, gitignored)
appearance:
  theme: "terracotta"
  font_size: "large"
  dark_mode: true
  density: "compact"

# myco.yaml (project, shared)
# No appearance section - uses defaults
```

### Appearance Control Implementation

Implement coordinated controls for theme, font size, dark mode, and density:

```typescript
interface AppearanceConfig {
  theme: 'sage' | 'moss' | 'terracotta' | 'dusk' | 'plum' | 'slate'
  fontSize: 'small' | 'medium' | 'large'
  darkMode: boolean
  density: 'compact' | 'comfortable' | 'spacious'
}

function useAppearanceConfig(): [AppearanceConfig, (config: Partial<AppearanceConfig>) => void] {
  // Read from .myco/local.yaml, fall back to defaults
  // Write updates to .myco/local.yaml via updateLocalConfig()
}
```

### Left Nav Placement Strategy

Position appearance controls for discoverability without cluttering:

```tsx
// Place in left navigation, grouped with other user preferences
<nav className="left-sidebar">
  <section className="user-preferences">
    <h3>Appearance</h3>
    <ThemePicker />
    <FontSizeControl />
    <DarkModeToggle />
    <DensityControl />
  </section>
</nav>
```

### Per-Session vs Persistent Preferences

**Persistent** (stored in `.myco/local.yaml`):
- Theme selection
- Font size
- Dark mode preference
- UI density

**Per-session** (component state only):
- Panel open/closed states
- Sort order for lists
- Temporary view filters
- Modal/dialog visibility

## Procedure F: Component Development Lifecycle

### Adding New UI Components to Settings

Follow the established pattern for settings page components:

1. **Create component file**:
```bash
touch packages/myco/ui/src/components/settings/NewSettingControl.tsx
```

2. **Implement with appearance awareness**:
```typescript
export function NewSettingControl() {
  const { theme, updateAppearance } = useAppearanceConfig()
  
  return (
    <Card className="setting-control">
      <Label>New Setting</Label>
      <Select 
        value={currentValue}
        onChange={handleChange}
        className="theme-aware-select"
      >
        {/* Options */}
      </Select>
    </Card>
  )
}
```

3. **Add to settings page**:
```typescript
// In packages/myco/ui/src/pages/Settings.tsx
import { NewSettingControl } from '../components/settings/NewSettingControl'

// Add to appropriate settings section
```

### Hard Refresh Requirements for Cache-Busting

During UI development, browser cache can persist stale assets. Force refresh when:

- CSS custom properties change
- Theme files are modified
- New components are added
- Asset imports change

```bash
# Clear all caches and restart dev server
rm -rf node_modules/.vite
rm -rf packages/*/dist
npm run clean
npm run dev
```

### DevTools Workflow for Component Development

Use browser DevTools effectively for UI development:

1. **Theme debugging**: Inspect CSS custom properties in Elements panel
2. **State debugging**: Use React DevTools to inspect component state
3. **Performance**: Use Performance panel to identify render bottlenecks
4. **Responsive testing**: Use device emulation for different screen sizes

### Playwright Testing Patterns for Visual State

Write Playwright tests that verify visual state across themes and configurations:

```typescript
test('theme picker updates appearance correctly', async ({ page }) => {
  await page.goto('/settings')
  
  // Test each theme
  for (const theme of ['sage', 'moss', 'terracotta']) {
    await page.selectOption('[data-testid="theme-picker"]', theme)
    
    // Verify CSS custom property is updated
    const primaryColor = await page.evaluate(() => 
      getComputedStyle(document.documentElement)
        .getPropertyValue('--primary')
    )
    
    expect(primaryColor).toMatch(EXPECTED_THEME_COLORS[theme])
  }
})
```

## Cross-Cutting Gotchas

**Theme Development Cache Issues**: Browser aggressively caches CSS files. Always hard refresh (Cmd+Shift+R / Ctrl+Shift+R) when developing themes or you'll see stale styles.

**CSS Custom Property Inheritance**: Theme variables are set on `:root` but can be overridden at component level. Check the cascade when debugging color issues.

**Instance Context Lost**: When components don't receive instance context, they default to daemon behavior. Ensure InstanceContext provider wraps the entire app tree.

**Favicon Not Updating**: Browser favicon cache is persistent. For immediate testing during development, open in private/incognito window or manually clear browser cache.

**Build Asset Missing**: If theme CSS or favicon assets aren't included in production build, check that they're explicitly imported in the entry point, not just referenced in component code.

**Hub Base-Path Version Mismatch**: Pre-#161 daemon versions don't understand `__MYCO_HUB_PREFIX__`, causing routing failures when proxied through hub. Verify daemon version compatibility before hub deployment.

**Worktree Nested UI Install Required**: New worktrees need `npm install` inside each nested UI workspace (`packages/*/ui/`) — root install doesn't cover them, leading to build failures.