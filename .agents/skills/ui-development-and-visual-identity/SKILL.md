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
- Understanding of Myco's config overlay pattern (`.myco/local.yaml` over `.myco/myco.yaml`)

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

Handle base-path routing for hub-proxied daemon UIs:

```typescript
// Detect hub context and configure router base-path
function detectHubBasePrefix(): string {
  if (window !== window.top) {
    const hubPrefix = (window as any).__MYCO_HUB_PREFIX__;
    if (hubPrefix) return hubPrefix;
  }
  return '/'; // Default to root for standalone daemon
}

// Configure React Router with dynamic base
<BrowserRouter basename={detectHubBasePrefix()}>
  <Routes>{/* App routes */}</Routes>
</BrowserRouter>
```

### Grove Multi-Project UI Switcher

Implement Slack/Linear-style project switcher for Grove multi-tenant navigation:

```typescript
// Project switcher component with URL-driven navigation
function ProjectSwitcher() {
  const { groveSlug, projectSlug } = useParams<{
    groveSlug: string; projectSlug: string;
  }>();
  
  const { projects } = useGroveProjects(groveSlug);
  const navigate = useNavigate();
  
  function switchProject(newProjectSlug: string) {
    navigate(`/g/${groveSlug}/p/${newProjectSlug}/`);
  }
  
  return (
    <DropdownMenu>
      <DropdownTrigger>
        <Button variant="ghost" className="project-switcher">
          {projectSlug} <ChevronDown />
        </Button>
      </DropdownTrigger>
      <DropdownContent>
        {projects.map(project => (
          <DropdownItem 
            key={project.slug}
            onClick={() => switchProject(project.slug)}
            className={project.slug === projectSlug ? 'active' : ''}
          >
            <ProjectIcon project={project} />
            {project.displayName}
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}
```

### Request Context Headers for Grove

Inject project context into API requests for multi-tenant safety:

```typescript
// Grove context headers injection
function useGroveApiClient() {
  const { groveSlug, projectSlug } = useGroveContext();
  
  const apiClient = useMemo(() => {
    const client = axios.create({
      baseURL: '/api/v1',
      headers: { 'X-Grove-Slug': groveSlug, 'X-Project-Slug': projectSlug }
    });
    
    client.interceptors.request.use(config => {
      config.headers = { ...config.headers, 'X-Grove-Slug': groveSlug, 'X-Project-Slug': projectSlug };
      return config;
    });
    
    return client;
  }, [groveSlug, projectSlug]);
  
  return apiClient;
}
```

### Machine-Scoped Runtime Status Badges

Implement sidebar badges to display DEV/BETA runtime status:

```typescript
// Runtime status badge component for sidebar footer
function RuntimeStatusBadge() {
  const { runtimeOrigin } = useDaemonStats();
  
  if (!runtimeOrigin || runtimeOrigin === 'stable') {
    return null; // No badge for stable/production runtime
  }
  
  const badgeConfig = {
    dev: { label: 'DEV', className: 'runtime-badge-dev', color: 'amber' },
    beta: { label: 'BETA', className: 'runtime-badge-beta', color: 'blue' }
  };
  
  const config = badgeConfig[runtimeOrigin as keyof typeof badgeConfig];
  
  return (
    <Badge 
      variant="outline" 
      className={`runtime-status-badge ${config.className}`}
    >
      {config.label}
    </Badge>
  );
}

// Hook to fetch daemon stats including runtime origin
function useDaemonStats() {
  return useQuery({
    queryKey: ['daemon-stats'],
    queryFn: async () => {
      const response = await fetch('/api/stats');
      if (!response.ok) throw new Error('Failed to fetch daemon stats');
      return response.json() as {
        runtimeOrigin: 'dev' | 'beta' | 'stable';
        version: string; uptime: number;
      };
    },
    refetchInterval: 30000
  });
}
```

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
touch packages/myco/ui/src/themes/ocean.css
```

2. **Define color palette**:
```css
:root[data-theme="ocean"] {
  --primary: #0ea5e9; --on-primary: #ffffff;
  --primary-container: #0284c7; --on-primary-container: #ffffff;
  --secondary: #64748b; --on-secondary: #ffffff;
  --secondary-container: #475569;
  --tertiary: #06b6d4; --on-tertiary: #ffffff;
  --tertiary-container: #0891b2;
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
    lib: { entry: 'src/index.ts', formats: ['es', 'cjs'] },
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: { globals: { react: 'React', 'react-dom': 'ReactDOM' } }
    }
  },
  css: {
    preprocessorOptions: {
      scss: { additionalData: `@import "src/themes/variables.scss";` }
    }
  }
})
```

### Worktree Build Environment Setup

Git worktrees require independent UI workspace installation for proper builds:

```bash
# After creating a worktree, install nested UI dependencies
cd .worktrees/feature-branch-name
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
```

### Appearance Control Implementation

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

### Per-Session vs Persistent Preferences

**Persistent** (stored in `.myco/local.yaml`):
- Theme selection, Font size, Dark mode preference, UI density

**Per-session** (component state only):
- Panel open/closed states, Sort order for lists, Temporary view filters, Modal/dialog visibility

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
      <Select value={currentValue} onChange={handleChange} className="theme-aware-select">
        {/* Options */}
      </Select>
    </Card>
  )
}
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
      getComputedStyle(document.documentElement).getPropertyValue('--primary')
    )
    
    expect(primaryColor).toMatch(EXPECTED_THEME_COLORS[theme])
  }
})
```

## Procedure G: Notification System Integration

### Notification Database Schema and Event Architecture

Create notification tables with proper constraints and project scoping:

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  project_id TEXT,  -- NULL for daemon-scoped notifications
  user_id TEXT,
  status TEXT DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'dismissed')),
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER,
  metadata TEXT,  -- JSON payload
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,  -- 'ui_banner', 'browser_push', 'email'
  delivered_at INTEGER DEFAULT (unixepoch()),
  acknowledged_at INTEGER,
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
);
```

Define consistent event payload structures:

```typescript
interface NotificationEvent {
  type: string;
  title: string;
  message: string;
  projectId?: string;  // Null for daemon notifications
  userId?: string;
  metadata?: Record<string, any>;
  expiresAt?: number;
  deliveryModes: NotificationDeliveryMode[];
}
```

### Domain Registry Wiring and Notification Emission

Register new domains and implement emission points:

```typescript
import { register } from '../notifications/registry.js';
import { notify } from '../notifications/notify.js';

export const YOUR_DOMAIN_DESCRIPTOR = {
  domain: 'your-domain',
  label: 'Your Domain',
  types: [
    { 
      id: 'your-domain.action.success', 
      label: 'Action completed', 
      defaultMode: 'banner', 
      defaultLevel: 'success' 
    },
    { 
      id: 'your-domain.action.error', 
      label: 'Action failed', 
      defaultMode: 'banner', 
      defaultLevel: 'error' 
    }
  ]
};

// Register during initialization
register(YOUR_DOMAIN_DESCRIPTOR);

// Emit in domain logic
export async function performDomainAction(entityId: string): Promise<void> {
  const vaultDir = getVaultDir();
  
  try {
    // ... perform domain logic
    
    notify(vaultDir, {
      domain: 'your-domain',
      type: 'your-domain.action.success',
      title: 'Action Completed',
      message: `Successfully processed ${entityId}`,
      link: `/domain/${entityId}`,
      metadata: { entityId, timestamp: Date.now() }
    });
  } catch (error) {
    notify(vaultDir, {
      domain: 'your-domain',
      type: 'your-domain.action.error',
      title: 'Action Failed',
      message: error.message,
      level: 'error',
      metadata: { entityId, error: error.message }
    });
    throw error;
  }
}
```

## Procedure H: Notification Display Components

### Notification Provider and React State Management

Build notification display components with proper state management:

```tsx
export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [dismissTimers, setDismissTimers] = useState<Map<string, NodeJS.Timeout>>(new Map());

  const addNotification = useCallback((notification: Omit<Notification, 'id'>) => {
    const id = crypto.randomUUID();
    const newNotification = { ...notification, id };
    
    setNotifications(prev => [newNotification, ...prev]);
    
    // Auto-dismiss after delay if configured
    if (notification.autoDismissMs) {
      const timer = setTimeout(() => dismissNotification(id), notification.autoDismissMs);
      setDismissTimers(prev => new Map(prev.set(id, timer)));
    }
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    const timer = dismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      setDismissTimers(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, [dismissTimers]);

  return (
    <NotificationContext.Provider value={{ notifications, addNotification, dismissNotification }}>
      {children}
    </NotificationContext.Provider>
  );
};

export const NotificationBanner: React.FC<{
  notification: Notification;
  onDismiss: () => void;
  onAction?: () => void;
}> = ({ notification, onDismiss, onAction }) => {
  const [isVisible, setIsVisible] = useState(false);
  
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  const handleDismiss = () => {
    setIsVisible(false);
    setTimeout(onDismiss, 300);
  };

  return (
    <div 
      className={`notification-banner ${isVisible ? 'notification-banner--visible' : ''}`}
      role="alert"
      aria-live="polite"
    >
      <div className="notification-banner__content">
        <span className="notification-banner__icon">
          {notification.type === 'skill_generated' ? '🎯' : 'ℹ️'}
        </span>
        <div className="notification-banner__text">
          <h4 className="notification-banner__title">{notification.title}</h4>
          <p className="notification-banner__message">{notification.message}</p>
        </div>
      </div>
      <div className="notification-banner__actions">
        {onAction && <button onClick={onAction}>View</button>}
        <button onClick={handleDismiss}>×</button>
      </div>
    </div>
  );
};
```

### Browser Notification Management and Rate Limiting

Implement progressive permission requests and rate limiting:

```typescript
class BrowserNotificationManager {
  private permissionRequested = false;
  private lastRequestTime = 0;
  private readonly REQUEST_COOLDOWN = 24 * 60 * 60 * 1000; // 24 hours

  async requestPermissionIfNeeded(): Promise<NotificationPermission> {
    const currentPermission = Notification.permission;
    if (currentPermission !== 'default') return currentPermission;
    
    // Avoid rapid permission requests
    const now = Date.now();
    if (this.permissionRequested && (now - this.lastRequestTime) < this.REQUEST_COOLDOWN) {
      return 'default';
    }
    
    this.permissionRequested = true;
    this.lastRequestTime = now;
    return await Notification.requestPermission();
  }

  async showNotificationSafely(title: string, options: NotificationOptions) {
    const permission = await this.requestPermissionIfNeeded();
    if (permission === 'granted') {
      return new Notification(title, {
        ...options,
        tag: options.tag || 'myco-notification',
        requireInteraction: false
      });
    }
    return this.showUIFallback(title, options);
  }
}

class NotificationRateLimiter {
  private readonly recentNotifications = new Map<string, number[]>();
  private readonly MAX_PER_HOUR = 10;
  private readonly MAX_PER_TYPE_PER_HOUR = 3;

  canShowNotification(type: string): boolean {
    const now = Date.now();
    const hourAgo = now - (60 * 60 * 1000);
    
    // Check global and per-type rate limits
    const allRecent = Array.from(this.recentNotifications.values())
      .flat()
      .filter(time => time > hourAgo);
    if (allRecent.length >= this.MAX_PER_HOUR) return false;
    
    const typeRecent = (this.recentNotifications.get(type) || [])
      .filter(time => time > hourAgo);
    return typeRecent.length < this.MAX_PER_TYPE_PER_HOUR;
  }
}
```

## Cross-Cutting Gotchas

**Theme Development Cache Issues**: Browser aggressively caches CSS files. Always hard refresh (Cmd+Shift+R / Ctrl+Shift+R) when developing themes or you'll see stale styles.

**CSS Custom Property Inheritance**: Theme variables are set on `:root` but can be overridden at component level. Check the cascade when debugging color issues.

**Instance Context Lost**: When components don't receive instance context, they default to daemon behavior. Ensure InstanceContext provider wraps the entire app tree.

**Favicon Not Updating**: Browser favicon cache is persistent. For immediate testing during development, open in private/incognito window or manually clear browser cache.

**Build Asset Missing**: If theme CSS or favicon assets aren't included in production build, check that they're explicitly imported in the entry point, not just referenced in component code.

**Hub Base-Path Version Mismatch**: Pre-#161 daemon versions don't understand `__MYCO_HUB_PREFIX__`, causing routing failures when proxied through hub. Verify daemon version compatibility before hub deployment.

**Worktree Nested UI Install Required**: New worktrees need `npm install` inside each nested UI workspace (`packages/*/ui/`) — root install doesn't cover them, leading to build failures.

**Grove Project Context Loss**: Without proper context headers and query cache scoping, data can leak between projects. Always inject `X-Grove-Slug` and `X-Project-Slug` headers and scope cache keys by project.

**Multi-Project Navigation State**: Project switcher state can become stale if not properly synchronized with URL changes. Use URL params as source of truth, not component state.

**Runtime Status Badge Missing**: If runtime badges don't appear, verify `/api/stats` endpoint returns `runtimeOrigin` field and hook is properly polling. DEV builds should show badges, stable should not.

**Machine-Scoped Runtime Context Lost**: Runtime status detection depends on machine-scoped runtime.command files. If context is lost, check that the runtime.command resolution is working and the stats endpoint reflects the correct runtime origin.

**Runtime Badge State Desync**: Runtime badges can become stale if not properly refreshed. Use polling intervals and ensure the daemon stats are being updated correctly when runtime origin changes.

**Notification Emission Point Timing**: Call `notify()` AFTER core operations succeed, not before. Failed operations shouldn't generate success notifications, but always emit error notifications in catch blocks.

**VaultDir Resolution**: Always pass correct `vaultDir` to `notify()`. Use `getVaultDir()` or undefined for no-op behavior. Never hardcode vault paths.

**Registry Timing**: Register notification domains during application initialization, not on-demand. Registry must be populated before first `notify()` call.

**Browser Permission Timing**: Never request notification permissions on page load without user interaction. Modern browsers block aggressive permission requests permanently.

**Rate Limiting Scope**: Implement rate limiting per notification type AND globally. Type-specific limits prevent spam, global limits prevent system overload.

**Database Transaction Scope**: Wrap notification creation and delivery recording in same transaction to ensure consistency.

**React State Batching**: Use React's batching mechanisms when adding multiple notifications rapidly to prevent display flickering.

**Memory Leak Prevention**: Always clear notification timers and event listeners when components unmount.

**Fallback Delivery Chain**: Design delivery modes with clear fallback priorities. If high-priority delivery fails, automatically attempt lower-priority modes rather than losing notifications.