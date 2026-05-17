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
const InstanceContext = createContext<'daemon' | 'collective' | 'marketing'>();

function NavigationComponent() {
  const instance = useContext(InstanceContext);
  const baseClasses = "nav-component";
  const instanceClasses = instance === 'collective' ? 'nav-collective' : 'nav-daemon';
  
  return <nav className={`${baseClasses} ${instanceClasses}`}>
    {/* Instance-specific navigation items */}
  </nav>;
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

### Grove Multi-Project UI Switcher

Implement Slack/Linear-style project switcher for Grove multi-tenant navigation:

```typescript
function ProjectSwitcher() {
  const { groveSlug, projectSlug } = useParams();
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
function useGroveApiClient() {
  const { groveSlug, projectSlug } = useGroveContext();
  
  const apiClient = useMemo(() => {
    const client = axios.create({
      baseURL: '/api/v1',
      headers: { 'X-Grove-Slug': groveSlug, 'X-Project-Slug': projectSlug }
    });
    return client;
  }, [groveSlug, projectSlug]);
  
  return apiClient;
}
```

### TabSwitcher Component for Team Consolidation

**Critical Phase 6 update**: Implement unified tabbed interface for team surface consolidation:

```typescript
interface TabSwitcherProps {
  tabs: Array<{ id: string; label: string; icon?: React.ReactNode; count?: number }>;
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
}

export function TabSwitcher({ tabs, activeTab, onTabChange, className }: TabSwitcherProps) {
  return (
    <div className={`tab-switcher ${className || ''}`} role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTab}
          className={`tab-button ${tab.id === activeTab ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.icon && <span className="tab-icon">{tab.icon}</span>}
          <span className="tab-label">{tab.label}</span>
          {tab.count !== undefined && (
            <span className="tab-count">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// Team consolidation usage - replaces separate status/sync components
function TeamSurface() {
  const [activeTab, setActiveTab] = useState('overview');
  const location = useLocation();
  
  const tabs = [
    { id: 'overview', label: 'Overview', icon: <BarChart3 /> },
    { id: 'members', label: 'Members', icon: <Users />, count: memberCount },
    { id: 'projects', label: 'Projects', icon: <FolderOpen />, count: projectCount },
    { id: 'activity', label: 'Activity', icon: <Activity /> }
  ];
  
  // Sync tab state with URL
  useEffect(() => {
    const urlTab = new URLSearchParams(location.search).get('tab');
    if (urlTab && tabs.find(t => t.id === urlTab)) {
      setActiveTab(urlTab);
    }
  }, [location.search]);
  
  return (
    <div className="team-surface">
      <TabSwitcher 
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(tabId) => {
          setActiveTab(tabId);
          navigate(`${location.pathname}?tab=${tabId}`);
        }}
      />
      <div className="tab-content">
        {activeTab === 'overview' && <TeamOverview />}
        {activeTab === 'members' && <TeamMembers />}
        {activeTab === 'projects' && <TeamProjects />}
        {activeTab === 'activity' && <TeamActivity />}
      </div>
    </div>
  );
}
```

### Machine-Scoped Runtime Status Badges

Implement sidebar badges to display DEV/BETA runtime status:

```typescript
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
  
  return <Badge variant="outline" className={`runtime-status-badge ${config.className}`}>{config.label}</Badge>;
}

function useDaemonStats() {
  return useQuery({
    queryKey: ['daemon-stats'],
    queryFn: async () => {
      const response = await fetch('/api/stats');
      if (!response.ok) throw new Error('Failed to fetch daemon stats');
      return response.json() as { runtimeOrigin: 'dev' | 'beta' | 'stable'; version: string; uptime: number; };
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

1. **Create theme definition file**: `touch packages/myco/ui/src/themes/ocean.css`
2. **Define color palette**: CSS custom properties with ocean color scheme
3. **Register in theme configuration**: Update `packages/myco/src/config/appearance-values.ts` APPEARANCE_THEMES array
4. **Add CSS import**: Update `packages/myco/ui/src/index.css` with new theme import

### Reserved Color Coordination

**Ochre is reserved for Collective instances** to maintain visual distinction:
- Daemon instances: Use any of the 6 main themes
- Collective instances: Always use ochre accent colors
- Marketing site: Typically sage or theme-neutral

## Procedure C: Multi-Instance Visual Identity Coordination

### Dynamic Tab Title Generation

Generate distinct browser tab titles that identify both project and instance type:

```typescript
function generateDynamicTitle(projectConfig: MycoConfig): string {
  const projectName = projectConfig.project?.name || 'Myco Project';
  const instanceType = 'Daemon'; // or 'Collective', 'Marketing'
  return `${projectName} | Myco ${instanceType}`;
}

// Update document title
document.title = generateDynamicTitle(config);
```

### Family Cohesion vs Instance Recognition

Balance unified Myco identity with practical tab distinction:

**Family cohesion**: Consistent typography, shared component design language, common interaction patterns
**Instance recognition**: Theme-based color distinction, dynamic tab titles, instance-specific favicon variants, contextual navigation differences

## Procedure D: Frontend Build Integration

### Vite Asset Pipeline Integration

Configure Vite for monorepo structure with theme asset coordination:

```typescript
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es', 'cjs'] },
    rollupOptions: { external: ['react', 'react-dom'], output: { globals: { react: 'React', 'react-dom': 'ReactDOM' } } }
  },
  css: { preprocessorOptions: { scss: { additionalData: `@import "src/themes/variables.scss";` } } }
});
```

### Worktree Build Environment Setup

**Critical Grove architecture**: Git worktrees require independent UI workspace installation and clean multi-worktree setup:

```bash
# Automated Grove worktree setup for Phase 6 development
function init_myco_worktree() {
  local branch_name="$1"
  local worktree_path=".worktrees/$branch_name"
  
  # Create and enter worktree
  git worktree add "$worktree_path" "$branch_name"
  cd "$worktree_path"
  
  # Install root dependencies
  npm install
  
  # Install nested UI workspaces separately (critical for Grove)
  for ui_workspace in packages/myco/ui packages/myco-hub/ui; do
    if [ -d "$ui_workspace" ]; then
      echo "Installing $ui_workspace..."
      (cd "$ui_workspace" && npm install)
    fi
  done
  
  # Build UI components
  npm run build:ui
  
  echo "Grove worktree $branch_name ready for Phase 6 development"
}
```

**Critical gotcha**: Each `packages/*/ui` workspace needs its own `npm install` run in worktrees.

**Phase 6 worktree benefits**: Clean isolation for Grove + Team rebuild, independent dependency resolution, parallel development workflow, easier branch switching without stale node_modules.

## Procedure E: Appearance Controls and User Preferences

### Configuration Overlay Pattern

Store appearance preferences in `.myco/local.yaml` for personal overrides:

```yaml
appearance:
  theme: "terracotta"
  font_size: "large"
  dark_mode: true
  density: "compact"
```

### Appearance Control Implementation

```typescript
interface AppearanceConfig {
  theme: 'sage' | 'moss' | 'terracotta' | 'dusk' | 'plum' | 'slate';
  fontSize: 'small' | 'medium' | 'large';
  darkMode: boolean;
  density: 'compact' | 'comfortable' | 'spacious';
}

function useAppearanceConfig(): [AppearanceConfig, (config: Partial<AppearanceConfig>) => void] {
  // Read from .myco/local.yaml, fall back to defaults
  // Write updates to .myco/local.yaml via updateLocalConfig()
}
```

## Procedure F: Component Development Lifecycle

### Adding New UI Components

Follow the established pattern for settings page components:

1. **Create component file**: `touch packages/myco/ui/src/components/settings/NewSettingControl.tsx`
2. **Implement with appearance awareness**: Use theme-aware classes and appearance config hooks
3. **Test across themes**: Verify component works correctly with all 6 themes
4. **Add Playwright tests**: Test component behavior and visual state

### Playwright Testing Patterns for Visual State

Write Playwright tests that verify visual state across themes and configurations:

```typescript
test('theme picker updates appearance correctly', async ({ page }) => {
  await page.goto('/settings');
  
  for (const theme of ['sage', 'moss', 'terracotta']) {
    await page.selectOption('[data-testid="theme-picker"]', theme);
    const primaryColor = await page.evaluate(() => 
      getComputedStyle(document.documentElement).getPropertyValue('--primary')
    );
    expect(primaryColor).toMatch(EXPECTED_THEME_COLORS[theme]);
  }
});
```

## Procedure G: Master-Detail Layout Architecture

### MasterDetailSplit Component Implementation

Implement responsive master-detail layout with keyboard navigation:

```typescript
interface MasterDetailSplitProps {
  masterContent: React.ReactNode;
  detailContent: React.ReactNode;
  showDetail: boolean;
  onCloseDetail: () => void;
  className?: string;
}

export function MasterDetailSplit({ masterContent, detailContent, showDetail, onCloseDetail, className }: MasterDetailSplitProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && showDetail) {
        onCloseDetail();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDetail, onCloseDetail]);

  return (
    <div className={`master-detail-split ${showDetail ? 'detail-open' : ''} ${className || ''}`}>
      <div className="master-panel">{masterContent}</div>
      {showDetail && (
        <div className="detail-panel">
          <button className="close-detail-btn" onClick={onCloseDetail} aria-label="Close detail view">×</button>
          {detailContent}
        </div>
      )}
    </div>
  );
}
```

### Responsive Master-Detail CSS

Define CSS patterns for responsive master-detail behavior:

```css
.master-detail-split {
  display: grid;
  height: 100%;
  grid-template-columns: 1fr;
  transition: grid-template-columns 0.2s ease-in-out;
}

.master-detail-split.detail-open { grid-template-columns: 350px 1fr; }
.master-panel { overflow: auto; border-right: 1px solid var(--border-color); }
.detail-panel { position: relative; overflow: auto; background: var(--surface-container); }

@media (max-width: 768px) {
  .master-detail-split.detail-open { grid-template-columns: 0 1fr; }
  .master-panel { overflow: hidden; }
}
```

## Procedure H: Operations Surface URL Routing

### Scope-Encoded URL Structure

Implement hierarchical URL routing that encodes scope context for proper multi-tenant operations:

```typescript
// URL structure: /operations/:scope/:category/:operationId?
// Examples: /operations/machine/daemons/daemon-123, /operations/grove/projects/grove-abc/proj-xyz

export function OperationsRouter() {
  return (
    <Routes>
      <Route path="/operations" element={<OperationsLayout />}>
        <Route index element={<OperationsOverview />} />
        <Route path=":scope" element={<OperationsScopeView />}>
          <Route path=":category" element={<OperationsCategoryView />}>
            <Route path="*" element={<OperationDetailView />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}

function OperationsLayout() {
  const { scope, category } = useParams();
  const location = useLocation();
  
  const scopeContext = useMemo(() => {
    const pathSegments = location.pathname.split('/').filter(Boolean);
    const operationsIndex = pathSegments.indexOf('operations');
    
    if (operationsIndex === -1 || pathSegments.length < 3) return null;
    
    const scopeType = pathSegments[operationsIndex + 1];
    const category = pathSegments[operationsIndex + 2];
    
    // Parse scope-specific identifiers
    if (scopeType === 'grove' && pathSegments.length >= 5) {
      return {
        scope: 'grove',
        groveSlug: pathSegments[operationsIndex + 3],
        projectSlug: pathSegments[operationsIndex + 4]
      };
    }
    
    return { scope: scopeType, category };
  }, [location.pathname]);
  
  return (
    <div className="operations-layout">
      <Breadcrumbs crumbs={buildBreadcrumbs(scopeContext)} />
      <ScopeContextProvider context={scopeContext}>
        <Outlet />
      </ScopeContextProvider>
    </div>
  );
}
```

## Procedure I: Unified Settings Registry

### Zod-Validated Settings Architecture

Implement centralized settings registry with Zod schema validation:

```typescript
import { z } from 'zod';

interface SettingDefinition<T = any> {
  key: string;
  label: string;
  description?: string;
  schema: z.ZodType<T>;
  scope: 'machine' | 'grove' | 'project';
  section: string;
  defaultValue: T;
  hidden?: boolean;
  deprecated?: { since: string; message: string };
}

class SettingsRegistry {
  private settings = new Map<string, SettingDefinition>();
  private sections = new Set<string>();
  
  register<T>(setting: SettingDefinition<T>) {
    if (!setting.key || !setting.label || !setting.schema) {
      throw new Error(`Invalid setting definition: ${setting.key}`);
    }
    
    this.settings.set(setting.key, setting);
    this.sections.add(setting.section);
  }
  
  validate<T>(key: string, value: unknown): T | ValidationError {
    const setting = this.settings.get(key);
    if (!setting) throw new Error(`Unknown setting: ${key}`);
    
    const result = setting.schema.safeParse(value);
    if (!result.success) return new ValidationError(key, result.error.errors);
    
    return result.data;
  }
}

export const settingsRegistry = new SettingsRegistry();

// Example registrations
settingsRegistry.register({
  key: 'daemon.port', label: 'Daemon Port', description: 'TCP port for the Myco daemon to listen on',
  schema: z.number().int().min(1024).max(65535), scope: 'machine', section: 'daemon', defaultValue: 3456
});

settingsRegistry.register({
  key: 'appearance.theme', label: 'UI Theme', description: 'Visual theme for the Myco interface',
  schema: z.enum(['sage', 'moss', 'terracotta', 'dusk', 'plum', 'slate']), scope: 'project', section: 'appearance', defaultValue: 'sage'
});
```

## Procedure J: Cloudflare API Constraint Adaptations

### Worker Environment Limitations

**Critical constraint**: Cloudflare Workers have strict API limitations affecting UI design decisions:

```typescript
// Adapt UI patterns for Cloudflare Worker constraints
function WorkerCompatibleImageUpload() {
  // CONSTRAINT: Limited file size and processing time
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit for worker processing
  const SUPPORTED_FORMATS = ['image/jpeg', 'image/png', 'image/webp'];
  
  function handleFileUpload(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error('File too large for Cloudflare Worker processing');
    }
    
    if (!SUPPORTED_FORMATS.includes(file.type)) {
      throw new Error('Unsupported format for worker environment');
    }
    
    // Process with worker-compatible approach
    return processImageInWorker(file);
  }
}

// API call patterns adapted for worker constraints
function useWorkerApi() {
  return useMutation({
    mutationFn: async (data: ApiRequest) => {
      // CONSTRAINT: 10 second execution limit
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000); // 9s timeout
      
      try {
        const response = await fetch('/api/worker-endpoint', {
          method: 'POST',
          body: JSON.stringify(data),
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }
        });
        
        clearTimeout(timeoutId);
        return response.json();
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new Error('Request timed out due to Cloudflare Worker constraints');
        }
        throw error;
      }
    }
  });
}
```

**UI design adaptations**: Smaller file upload limits, simplified processing workflows, timeout-aware user feedback, progressive enhancement for worker limitations.

## Cross-Cutting Gotchas

### Theme Development Cache Issues

**Browser aggressively caches CSS files**. Always hard refresh (Cmd+Shift+R / Ctrl+Shift+R) when developing themes or you'll see stale styles.

### CSS Custom Property Inheritance

**Theme variables are set on `:root` but can be overridden at component level**. Check the cascade when debugging color issues.

### Instance Context Lost

**When components don't receive instance context, they default to daemon behavior**. Ensure InstanceContext provider wraps the entire app tree.

### Worktree Nested UI Install Required

**New Grove worktrees need `npm install` inside each nested UI workspace** (`packages/*/ui/`) — root install doesn't cover them, leading to build failures during Phase 6 development.

### Grove Project Context Loss

**Without proper context headers and query cache scoping, data can leak between projects**. Always inject `X-Grove-Slug` and `X-Project-Slug` headers and scope cache keys by project.

### Runtime Status Badge Missing

**If runtime badges don't appear, verify `/api/stats` endpoint returns `runtimeOrigin` field** and hook is properly polling. DEV builds should show badges, stable should not.

### Master-Detail State Sync

**URL params must drive master-detail state, not vice versa**. Component state that doesn't reflect in the URL breaks browser history and deep linking.

### TabSwitcher State Persistence

**Tab state should sync with URL query parameters for proper browser history**. Don't rely on component state alone for active tab tracking from Phase 6 consolidation.

### Phase 6 Worktree Dependencies

**Phase 6 Grove worktree setup must install dependencies independently in each UI workspace**. Missing nested installs cause build failures during Grove + Team rebuild development.

### Cloudflare Worker UI Constraints

**Cloudflare Worker API limitations require UI adaptations**: reduced file upload limits, timeout-aware processing, worker-compatible data formats, graceful degradation when worker APIs fail.