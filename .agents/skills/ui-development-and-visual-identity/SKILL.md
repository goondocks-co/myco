---
name: myco:ui-development-and-visual-identity
description: |
  Comprehensive procedures for building, maintaining, and extending Myco's React-based UI components and multi-instance visual identity system. Covers React component architecture patterns, theme system implementation with 6-theme variants, multi-instance visual coordination for daemon/collective/marketing distinction, frontend build integration, appearance controls, and component development lifecycle. Use when implementing new UI components, extending the theme system, coordinating visual identity across multiple Myco instances, or troubleshooting frontend build issues, even if the user doesn't explicitly ask for UI development guidance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# UI Development and Visual Identity System

Myco's UI spans multiple contexts (daemon, collective, marketing) with 6-theme architecture and multi-instance coordination.

## Prerequisites

- Myco project with `.myco/` vault directory  
- Node.js environment with npm workspaces
- Access to `packages/myco/ui/` and related UI directories

## Procedure A: React Component Architecture

### Multi-Instance Component Design

```typescript
const InstanceContext = createContext<'daemon' | 'collective' | 'marketing'>();

function NavigationComponent() {
  const instance = useContext(InstanceContext);
  const instanceClasses = instance === 'collective' ? 'nav-collective' : 'nav-daemon';
  return <nav className={`nav-component ${instanceClasses}`}>{/* content */}</nav>;
}
```

### Grove Project Switcher

```typescript
function ProjectSwitcher() {
  const { groveSlug, projectSlug } = useParams();
  const { projects } = useGroveProjects(groveSlug);
  
  return (
    <DropdownMenu>
      <DropdownTrigger>
        <Button variant="ghost">{projectSlug} <ChevronDown /></Button>
      </DropdownTrigger>
      <DropdownContent>
        {projects.map(project => (
          <DropdownItem key={project.slug} onClick={() => navigate(`/g/${groveSlug}/p/${project.slug}/`)}>
            {project.displayName}
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}
```

### Enhanced TabSwitcher for Phase 6 Team Consolidation

**Critical update**: Queue-aware TabSwitcher with error state handling:

```typescript
interface TabSwitcherProps {
  tabs: Array<{ 
    id: string; 
    label: string; 
    icon?: React.ReactNode; 
    count?: number;
    badge?: 'active' | 'pending' | 'error';
    disabled?: boolean;
  }>;
  activeTab: string;
  onTabChange: (tabId: string) => void;
  layout?: 'horizontal' | 'vertical';
}

export function TabSwitcher({ tabs, activeTab, onTabChange, layout = 'horizontal' }: TabSwitcherProps) {
  return (
    <div className={`tab-switcher tab-switcher-${layout}`} role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTab}
          disabled={tab.disabled}
          className={`tab-button ${tab.id === activeTab ? 'active' : ''} ${tab.badge ? `badge-${tab.badge}` : ''}`}
          onClick={() => !tab.disabled && onTabChange(tab.id)}
        >
          {tab.icon && <span className="tab-icon">{tab.icon}</span>}
          <span className="tab-label">{tab.label}</span>
          {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
          {tab.badge && <span className={`tab-badge tab-badge-${tab.badge}`} />}
        </button>
      ))}
    </div>
  );
}

function TeamSurface() {
  const [activeTab, setActiveTab] = useState('overview');
  const { queueStatus } = useTeamQueueStatus();
  
  const tabs = [
    { id: 'overview', label: 'Overview', icon: <BarChart3 /> },
    { 
      id: 'queue', 
      label: 'Queue', 
      icon: <Clock />, 
      count: queueStatus.pending,
      badge: queueStatus.hasErrors ? 'error' : queueStatus.hasActive ? 'active' : undefined
    },
    { id: 'members', label: 'Members', icon: <Users /> },
    { id: 'projects', label: 'Projects', icon: <FolderOpen />, disabled: !hasProjectAccess }
  ];
  
  // Auto-switch to queue tab on critical errors
  useEffect(() => {
    if (queueStatus.hasErrors && activeTab !== 'queue') {
      setActiveTab('queue');
      navigate(`${location.pathname}?tab=queue`);
    }
  }, [queueStatus.hasErrors]);
  
  return (
    <div className="team-surface">
      <TabSwitcher tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="tab-content">
        {activeTab === 'queue' && <TeamQueueManager queueStatus={queueStatus} />}
        {/* other tab content */}
      </div>
    </div>
  );
}
```

## Procedure B: Theme System

### Core Theme Architecture

```css
:root[data-theme="sage"] {
  --primary: #abcfb8;
  --on-primary: #163627;
  --secondary: #edbf7f;
  --tertiary: #ffb4a1;
}
```

### Adding New Themes

1. Create `packages/myco/ui/src/themes/new-theme.css`
2. Define CSS custom properties
3. Register in `packages/myco/src/config/appearance-values.ts`
4. Import in `packages/myco/ui/src/index.css`

## Procedure C: Enhanced Grove Worktree Architecture

**Critical Grove improvement**: Streamlined worktree setup with UI workspace verification:

```bash
function init_grove_worktree_enhanced() {
  local branch_name="$1"
  local worktree_path=".worktrees/$branch_name"
  
  echo "🌱 Creating Grove worktree: $branch_name"
  git worktree add "$worktree_path" "$branch_name"
  cd "$worktree_path"
  
  # Install with parallel UI workspaces
  npm install --include-workspace-root
  
  echo "🎨 Installing UI workspaces in parallel..."
  for workspace in packages/myco/ui packages/myco-hub/ui; do
    [ -d "$workspace" ] && (cd "$workspace" && npm install) &
  done
  wait
  
  # Verify UI workspace integrity
  echo "🔍 Verifying UI workspaces..."
  for workspace in packages/myco/ui packages/myco-hub/ui; do
    [ -d "$workspace" ] && (cd "$workspace" && npm run type-check) || {
      echo "❌ Type check failed in $workspace"; return 1
    }
  done
  
  npm run build:ui || { echo "❌ UI build failed"; return 1; }
  
  # Generate worktree config
  cat > ".myco/worktree.yaml" << EOF
worktree:
  branch: $branch_name
  ui_workspaces_verified: true
development:
  hot_reload: true
  theme_dev_mode: true
EOF
  
  echo "✅ Grove worktree ready"
}
```

### Vite Configuration for Grove

```typescript
export default defineConfig({
  server: {
    fs: { allow: ['..', '../..', '../../..'] }, // Worktree compatibility
    watch: {
      include: ['src/**/*', '../../../shared/**/*'],
      exclude: ['node_modules/**', '.worktrees/**']
    }
  }
});
```

## Procedure D: Enhanced Cloudflare Worker Constraints

**Critical constraint updates**: Comprehensive worker limitations with UI adaptations:

```typescript
function CloudflareWorkerCompatibleUpload() {
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit
  const EXECUTION_TIMEOUT = 9000; // 9s timeout
  const SUPPORTED_FORMATS = ['image/jpeg', 'image/png', 'image/webp'];
  
  function validateFileForWorker(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      return { 
        valid: false, 
        error: `File ${(file.size/1024/1024).toFixed(2)}MB exceeds 1MB worker limit` 
      };
    }
    if (!SUPPORTED_FORMATS.includes(file.type)) {
      return { valid: false, error: `Format ${file.type} not supported in worker` };
    }
    return { valid: true };
  }
  
  function useWorkerApiClient() {
    return useMutation({
      mutationFn: async (data: ApiRequest) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT);
        
        try {
          const response = await fetch('/api/worker-endpoint', {
            method: 'POST',
            body: JSON.stringify(data),
            signal: controller.signal,
            headers: { 'X-Worker-Timeout': EXECUTION_TIMEOUT.toString() }
          });
          
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`Worker request failed: ${response.status}`);
          return response.json();
          
        } catch (error) {
          clearTimeout(timeoutId);
          if (error.name === 'AbortError') {
            throw new Error('Worker timeout - try reducing file size');
          }
          throw error;
        }
      }
    });
  }
}

// Worker-aware form with constraint validation
function WorkerConstraintForm() {
  const [file, setFile] = useState<File | null>(null);
  const validation = file ? validateFileForWorker(file) : { valid: false };
  
  return (
    <form>
      <input 
        type="file" 
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        accept="image/jpeg,image/png,image/webp"
      />
      <Badge variant={validation.valid ? 'success' : 'warning'}>
        Max 1MB • Cloudflare limits apply
      </Badge>
      {!validation.valid && validation.error && <p className="error">{validation.error}</p>}
      <Button disabled={!validation.valid}>Upload</Button>
    </form>
  );
}
```

## Procedure E: Master-Detail Layout

```typescript
export function MasterDetailSplit({ masterContent, detailContent, showDetail, onCloseDetail }) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && showDetail) onCloseDetail();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDetail, onCloseDetail]);

  return (
    <div className={`master-detail-split ${showDetail ? 'detail-open' : ''}`}>
      <div className="master-panel">{masterContent}</div>
      {showDetail && (
        <div className="detail-panel">
          <button onClick={onCloseDetail}>×</button>
          {detailContent}
        </div>
      )}
    </div>
  );
}
```

## Procedure F: Settings Registry

```typescript
interface SettingDefinition<T> {
  key: string;
  label: string;
  schema: z.ZodType<T>;
  scope: 'machine' | 'grove' | 'project';
  section: string;
  defaultValue: T;
}

class SettingsRegistry {
  private settings = new Map<string, SettingDefinition>();
  
  register<T>(setting: SettingDefinition<T>) {
    this.settings.set(setting.key, setting);
  }
  
  validate<T>(key: string, value: unknown): T {
    const setting = this.settings.get(key);
    const result = setting?.schema.safeParse(value);
    if (!result?.success) throw new Error(`Validation failed: ${key}`);
    return result.data;
  }
}
```

## Procedure G: Appearance Controls

```typescript
interface AppearanceConfig {
  theme: 'sage' | 'moss' | 'terracotta' | 'dusk' | 'plum' | 'slate';
  fontSize: 'small' | 'medium' | 'large';
  darkMode: boolean;
}

function useAppearanceConfig(): [AppearanceConfig, (config: Partial<AppearanceConfig>) => void] {
  // Read from .myco/local.yaml, write updates
}
```

## Procedure H: Runtime Status Badges

```typescript
function RuntimeStatusBadge() {
  const { runtimeOrigin } = useDaemonStats();
  
  if (!runtimeOrigin || runtimeOrigin === 'stable') return null;
  
  const config = runtimeOrigin === 'dev' 
    ? { label: 'DEV', className: 'runtime-badge-dev' }
    : { label: 'BETA', className: 'runtime-badge-beta' };
  
  return <Badge variant="outline" className={config.className}>{config.label}</Badge>;
}
```

## Cross-Cutting Gotchas

### Theme Development
**Browser caches CSS aggressively**. Always hard refresh (Cmd+Shift+R) when developing themes.

### Grove Worktree Dependencies
**Each Grove worktree needs independent UI workspace `npm install`**. The enhanced setup handles this automatically with parallel installation and verification.

### TabSwitcher Queue Integration  
**Queue error states must trigger auto-navigation to queue tab**. Missing queue status monitoring breaks Phase 6 team consolidation workflow.

### Cloudflare Worker Constraints
**Worker timeout errors need differentiated handling**. Use worker-specific error types and provide actionable constraint guidance to users.

### Instance Context
**Components default to daemon behavior without proper InstanceContext**. Ensure context provider wraps the app tree.

### Master-Detail State
**URL params must drive state, not component state**. Missing URL sync breaks browser history.

### Project Context Leaks
**Grove multi-tenant data can leak without proper headers**. Always inject `X-Grove-Slug` and `X-Project-Slug` headers.

### UI Workspace Verification
**Missing type checks after worktree creation cause build failures**. The enhanced setup includes automatic verification steps.