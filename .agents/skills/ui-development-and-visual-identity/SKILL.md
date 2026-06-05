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
```

### URL State Management with React Router

**Critical update**: Use React Router hooks instead of window.location for MemoryRouter compatibility:

```typescript
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

function useUrlState() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Use React Router hooks instead of window.location
  // This ensures MemoryRouter compatibility for testing and Electron contexts
  const readUrlState = () => ({
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    params: Object.fromEntries(searchParams.entries())
  });
  
  const updateUrlState = (newParams: Record<string, string>) => {
    const currentParams = Object.fromEntries(searchParams.entries());
    const mergedParams = { ...currentParams, ...newParams };
    setSearchParams(mergedParams);
  };
  
  return { readUrlState, updateUrlState };
}
```

### Auth-Gated Attachment Rendering

Attachment bytes are served by a bearer-token-gated daemon route (`/api/g/:groveId/p/:projectId/attachments/:file`). A bare `<img src>` cannot send the `x-myco-auth` header — always use `AttachmentImage` or `useAttachmentObjectUrls` from `packages/myco/ui/src/components/ui/attachment-image.tsx`:

```typescript
import { AttachmentImage, useAttachmentObjectUrls } from '../ui/attachment-image';

// Single image (preferred for all attachment display)
<AttachmentImage filePath={attachment.file_path} alt="attachment" />

// Multiple images — for lightbox or raw URL access
const objectUrls = useAttachmentObjectUrls(attachments.map(a => a.file_path));
```

`AttachmentImage` fetches with the `x-myco-auth` bearer token and renders a blob object URL. The (Grove, project) scope is resolved from the current project selection automatically. Never use `<img src={attachment.file_path}>` directly.

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
  
  echo "✅ Grove worktree ready"
}
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
}
```

## Procedure E: Master-Detail Layout

**Critical update**: Layout primitives own spacing decisions, not leaf pages:

```typescript
export function MasterDetailSplit({ 
  masterContent, 
  detailContent, 
  showDetail, 
  onCloseDetail,
  spacing = 'default' // Primitive controls spacing
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && showDetail) onCloseDetail();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDetail, onCloseDetail]);

  const spacingClass = {
    'compact': 'spacing-compact',
    'default': 'spacing-default',
    'comfortable': 'spacing-comfortable'
  }[spacing];

  return (
    <div className={`master-detail-split ${showDetail ? 'detail-open' : ''} ${spacingClass}`}>
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

## Procedure I: PR Merge Discipline and Go-Ahead Patterns

**Critical update**: Wait for explicit go-ahead signals before merging PRs:

```typescript
interface PRMergeChecks {
  reviewsComplete: boolean;
  ciPassing: boolean;
  conflictsResolved: boolean;
  goAheadReceived: boolean;
}

function PRMergeController({ prId, checks }: { prId: string; checks: PRMergeChecks }) {
  const canMerge = Object.values(checks).every(Boolean);
  
  return (
    <div className="pr-merge-controls">
      <ChecklistItem checked={checks.reviewsComplete} label="Reviews complete" />
      <ChecklistItem checked={checks.ciPassing} label="CI passing" />
      <ChecklistItem checked={checks.conflictsResolved} label="Conflicts resolved" />
      <ChecklistItem 
        checked={checks.goAheadReceived} 
        label="Explicit go-ahead received"
        critical
      />
      <Button 
        disabled={!canMerge}
        onClick={() => mergePR(prId)}
      >
        {canMerge ? 'Merge PR' : 'Waiting for go-ahead signal'}
      </Button>
    </div>
  );
}
```

## Cross-Cutting Gotchas

### Theme Development
**Browser caches CSS aggressively**. Always hard refresh (Cmd+Shift+R) when developing themes.

### Grove Worktree Dependencies
**Each Grove worktree needs independent UI workspace `npm install`**. The enhanced setup handles this automatically with parallel installation and verification.

### TabSwitcher Queue Integration  
**Queue error states must trigger auto-navigation to queue tab**. Missing queue status monitoring breaks Phase 6 team consolidation workflow.

### Instance Context
**Components default to daemon behavior without proper InstanceContext**. Ensure context provider wraps the app tree.

### Master-Detail State
**URL params must drive state, not component state**. Missing URL sync breaks browser history.

### Project Context Leaks
**Grove multi-tenant data can leak without proper headers**. Always inject `X-Grove-Slug` and `X-Project-Slug` headers.

### React Router vs Window Location
**Using window.location directly breaks MemoryRouter compatibility**. Always use React Router hooks (useLocation, useNavigate, useSearchParams) for URL state management.

### Layout Primitive Spacing Authority
**Leaf pages must not override layout primitive spacing decisions**. MasterDetailSplit and similar primitives own spacing through props — leaf components should not apply conflicting margin/padding styles.

### PR Merge Go-Ahead Discipline  
**Auto-merge without explicit go-ahead signals creates integration risks**. Always implement go-ahead confirmation patterns for non-trivial PRs.

### Attachment Routes Are Auth-Gated
**Never render attachment images with bare `<img src>`**. Attachment routes (`/api/g/:groveId/p/:projectId/attachments/:file`) require the `x-myco-auth` bearer token, which a standard `<img>` element cannot send. Use `AttachmentImage` from `packages/myco/ui/src/components/ui/attachment-image.tsx` for all attachment display. Use `useAttachmentObjectUrls` when raw blob URLs are needed (e.g. lightboxes). Using a bare image tag silently renders a broken image or an auth error response as binary garbage.
