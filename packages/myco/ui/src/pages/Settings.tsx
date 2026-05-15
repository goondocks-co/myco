import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  Activity,
  Bell,
  Bot,
  Brain,
  GitBranch,
  MessageSquare,
  RotateCcw,
  Save,
  ScrollText,
  Search,
  Sparkles,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { Surface } from '../components/ui/surface';
import { PageHeader } from '../components/ui/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { RestartGateProvider, RestartBanner } from '../components/config/restart-gate';
import { ScopeBadge } from '../components/config/ScopePill';
import {
  ListField,
  NumberField,
  SecretField,
  SelectField,
  TextField,
  ToggleField,
} from '../components/config';
import { PlanCaptureCard } from '../components/config/PlanCaptureCard';
import { NotificationSettings } from '../components/notifications/NotificationSettings';
import { AgentProviderCard } from '../components/settings/AgentProviderCard';
import { EmbeddingCard } from '../components/settings/EmbeddingCard';
import { ReleaseProvenanceCard } from '../components/settings/ReleaseProvenanceCard';
import { SETTINGS_GROUPS, type SettingField, type SettingGroup, type SettingScope } from '../settings/manifest';
import { useUnifiedSettings } from '../hooks/use-unified-settings';
import { useProjectSelection } from '../hooks/use-project-selection';
import { useGroves } from '../hooks/use-groves';
import { defaultSelection, selectionFromLast } from '../lib/selection';
import { cn } from '../lib/cn';

/* ---------- Icon registry ---------- */

type IconComponent = ComponentType<{ className?: string }>;

const ICONS: Record<string, IconComponent> = {
  Activity,
  Bell,
  Bot,
  Brain,
  GitBranch,
  MessageSquare,
  RotateCcw,
  Save,
  ScrollText,
  Sparkles,
  Users,
  Wrench,
};

function GroupIcon({ name, className }: { name: string; className?: string }) {
  const Cmp = ICONS[name] ?? Bot;
  return <Cmp className={className} />;
}

/* ---------- Field-control routing ---------- */

const CONTROL_BY_KIND = {
  toggle: ToggleField,
  select: SelectField,
  number: NumberField,
  text: TextField,
  list: ListField,
  secret: SecretField,
} as const;

const SCOPE_BADGE_FOR: Record<SettingScope, 'project' | 'grove' | 'machine'> = {
  project: 'project',
  grove: 'grove',
  machine: 'machine',
};

/* ---------- Filter state ---------- */

type ScopeFilter = 'all' | SettingScope;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function fieldMatchesSearch(field: SettingField, needle: string): boolean {
  if (!needle) return true;
  const hay = `${field.label} ${field.key} ${field.category}`.toLowerCase();
  return hay.includes(needle.toLowerCase());
}

function groupVisibleFields(group: SettingGroup, scope: ScopeFilter, search: string): SettingField[] {
  return group.fields.filter((f) => {
    if (scope !== 'all' && f.scope !== scope) return false;
    return fieldMatchesSearch(f, search);
  });
}

function groupIsVisible(
  group: SettingGroup,
  visibleFields: SettingField[],
  scope: ScopeFilter,
  search: string,
  isCustom: boolean,
): boolean {
  // Custom-card groups stay visible whenever scope matches at least one of
  // their declared fields and there's no active search (search hides them
  // because the rich cards don't proxy keyword filtering yet).
  if (isCustom) {
    if (search.trim().length > 0) {
      // Hide custom cards once a search query is active — they don't expose
      // their internal fields to the filter.
      return visibleFields.length > 0;
    }
    if (scope === 'all') return true;
    return group.fields.some((f) => f.scope === scope);
  }
  return visibleFields.length > 0;
}

/* ---------- Render policy ---------- */

const CUSTOM_GROUP_IDS = new Set([
  'agent',
  'embedding',
  'capture',
  'release-provenance',
  'notifications',
]);

const CUSTOM_GROUP_RENDERERS: Record<string, () => JSX.Element> = {
  agent: () => <AgentProviderCard />,
  embedding: () => <EmbeddingCard />,
  capture: () => <PlanCaptureCard />,
  'release-provenance': () => <ReleaseProvenanceCard />,
  notifications: () => <NotificationSettings />,
};

/* ---------- Page ---------- */

export default function Settings() {
  return (
    <RestartGateProvider>
      <SettingsInner />
    </RestartGateProvider>
  );
}

function SettingsInner() {
  // Unified /settings can land here without a URL-bound project (the
  // sidebar Settings entry is machine-tier). When that happens we fall
  // back to the last-used project from useGroves so project- and
  // grove-scoped fields stay editable instead of showing a misleading
  // "select a project" banner — writes already resolve to the daemon's
  // active selection. The banner only appears when no projects exist
  // on the machine at all.
  const urlSelection = useProjectSelection();
  const groves = useGroves();
  const fallbackSelection = useMemo(() => {
    const list = groves.data?.groves ?? [];
    if (list.length === 0) return null;
    return selectionFromLast(list) ?? defaultSelection(list);
  }, [groves.data]);
  const projectSelection = urlSelection ?? fallbackSelection;
  const hasProject = projectSelection !== null;
  const unified = useUnifiedSettings();

  const [scope, setScope] = useState<ScopeFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 150);
  const [activeGroupId, setActiveGroupId] = useState<string>(SETTINGS_GROUPS[0]?.id ?? '');
  const mainScrollRef = useRef<HTMLDivElement | null>(null);

  // Per-group visible fields + visibility, computed once per filter pass.
  const groupSummaries = useMemo(() => {
    return SETTINGS_GROUPS.map((group) => {
      const isCustom = CUSTOM_GROUP_IDS.has(group.id);
      const visibleFields = groupVisibleFields(group, scope, search);
      const visible = groupIsVisible(group, visibleFields, scope, search, isCustom);
      const scopes = new Set(group.fields.map((f) => f.scope));
      const mixedScopes = scopes.size > 1;
      return { group, isCustom, visibleFields, visible, mixedScopes };
    });
  }, [scope, search]);

  const anyVisible = groupSummaries.some((s) => s.visible);

  // Honor an initial #hash so deep links work.
  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
    if (!hash) return;
    if (!SETTINGS_GROUPS.some((g) => g.id === hash)) return;
    setActiveGroupId(hash);
    const el = document.getElementById(hash);
    if (el) {
      // Defer one tick so the layout has settled.
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'auto', block: 'start' }));
    }
  }, []);

  const handleTocClick = useCallback((id: string) => {
    setActiveGroupId(id);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title="Settings"
          subtitle="Project, Grove, and Machine settings in one place. Use the filter bar to narrow by scope."
        />
        {!hasProject && (
          <div className="mb-3 rounded-md border border-outline-variant/30 bg-surface-container/40 px-3 py-2 font-sans text-sm text-on-surface-variant">
            Select a project to edit Project and Grove settings. Machine-scoped settings are still editable below.
          </div>
        )}
        <RestartBanner />
        <FilterBar
          scope={scope}
          onScopeChange={setScope}
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          scopeCounts={unified.scopeCounts}
        />
      </div>

      <div ref={mainScrollRef} className="flex-1 overflow-auto px-6 pb-6">
        <div className="flex gap-6">
          <TocRail
            summaries={groupSummaries}
            activeId={activeGroupId}
            onSelect={handleTocClick}
          />
          <main className="flex-1 space-y-4">
            {!anyVisible && (
              <div className="flex h-64 items-center justify-center font-sans text-sm text-on-surface-variant">
                No settings match your filters.
              </div>
            )}
            {groupSummaries.map((s) =>
              s.visible ? (
                <SettingsGroupCard
                  key={s.group.id}
                  group={s.group}
                  isCustom={s.isCustom}
                  visibleFields={s.visibleFields}
                  mixedScopes={s.mixedScopes}
                  hasProject={hasProject}
                  unified={unified}
                />
              ) : null,
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/* ---------- Filter bar ---------- */

interface FilterBarProps {
  scope: ScopeFilter;
  onScopeChange: (scope: ScopeFilter) => void;
  searchInput: string;
  onSearchChange: (value: string) => void;
  scopeCounts: Record<SettingScope, number>;
}

const SCOPE_OPTIONS: { value: ScopeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'project', label: 'Project' },
  { value: 'grove', label: 'Grove' },
  { value: 'machine', label: 'Machine' },
];

function FilterBar({ scope, onScopeChange, searchInput, onSearchChange, scopeCounts }: FilterBarProps) {
  const totalCount = scopeCounts.project + scopeCounts.grove + scopeCounts.machine;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="inline-flex overflow-hidden rounded-md border border-outline-variant/30 bg-surface-container/30">
        {SCOPE_OPTIONS.map((opt) => {
          const count = opt.value === 'all' ? totalCount : scopeCounts[opt.value];
          const active = opt.value === scope;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onScopeChange(opt.value)}
              aria-pressed={active}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 font-sans text-sm transition-colors',
                active
                  ? 'bg-primary/15 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container-high/40 hover:text-on-surface',
              )}
            >
              <span>{opt.label}</span>
              <Badge variant="outline" className="px-1 py-0 text-[10px]">{count}</Badge>
            </button>
          );
        })}
      </div>
      <div className="relative flex-1 min-w-[16rem] max-w-md">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" />
        <Input
          type="search"
          value={searchInput}
          placeholder="Search settings..."
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8 pr-8"
        />
        {searchInput && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onSearchChange('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-1 text-on-surface-variant hover:bg-surface-container-high/40 hover:text-on-surface"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- TOC rail ---------- */

interface GroupSummary {
  group: SettingGroup;
  isCustom: boolean;
  visibleFields: SettingField[];
  visible: boolean;
  mixedScopes: boolean;
}

interface TocRailProps {
  summaries: GroupSummary[];
  activeId: string;
  onSelect: (id: string) => void;
}

function TocRail({ summaries, activeId, onSelect }: TocRailProps) {
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-0 hidden h-fit w-[200px] shrink-0 self-start lg:block"
    >
      <ul className="space-y-0.5 py-2">
        {summaries.map(({ group, visible, isCustom, visibleFields }) => {
          const active = group.id === activeId;
          const count = isCustom ? group.fields.length : visibleFields.length;
          return (
            <li key={group.id}>
              <button
                type="button"
                onClick={() => onSelect(group.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-sm transition-colors',
                  active
                    ? 'bg-surface-container-high/60 text-on-surface'
                    : 'text-on-surface-variant hover:bg-surface-container/40 hover:text-on-surface',
                  !visible && 'opacity-40',
                )}
              >
                <GroupIcon name={group.icon} className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{group.label}</span>
                <span className="font-mono text-[10px] text-on-surface-variant">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ---------- Group card ---------- */

interface SettingsGroupCardProps {
  group: SettingGroup;
  isCustom: boolean;
  visibleFields: SettingField[];
  mixedScopes: boolean;
  hasProject: boolean;
  unified: ReturnType<typeof useUnifiedSettings>;
}

function SettingsGroupCard({
  group,
  isCustom,
  visibleFields,
  mixedScopes,
  hasProject,
  unified,
}: SettingsGroupCardProps) {
  return (
    <Surface level="low" className="rounded-md p-4">
      <section id={group.id} className="scroll-mt-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <GroupIcon name={group.icon} className="h-4 w-4 text-on-surface-variant" />
          <div className="flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
              {group.category}
            </div>
            <h2 className="font-sans text-base text-on-surface">{group.label}</h2>
            <p className="font-sans text-xs text-on-surface-variant">{group.desc}</p>
          </div>
          {mixedScopes && (
            <Badge variant="outline" className="text-[10px]">
              Mixed scopes
            </Badge>
          )}
        </div>

        {isCustom ? (
          <CustomGroupBody groupId={group.id} />
        ) : (
          <FieldGroupBody
            fields={visibleFields}
            hasProject={hasProject}
            unified={unified}
          />
        )}
      </section>
    </Surface>
  );
}

function CustomGroupBody({ groupId }: { groupId: string }) {
  const render = CUSTOM_GROUP_RENDERERS[groupId];
  if (!render) return null;
  return <div>{render()}</div>;
}

/* ---------- Manifest-driven field rows ---------- */

interface FieldGroupBodyProps {
  fields: SettingField[];
  hasProject: boolean;
  unified: ReturnType<typeof useUnifiedSettings>;
}

function FieldGroupBody({ fields, hasProject, unified }: FieldGroupBodyProps) {
  if (fields.length === 0) {
    return (
      <p className="font-sans text-sm text-on-surface-variant">
        No fields match the current filters.
      </p>
    );
  }
  return (
    <div className="divide-y divide-outline-variant/20">
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          hasProject={hasProject}
          unified={unified}
        />
      ))}
    </div>
  );
}

interface FieldRowProps {
  field: SettingField;
  hasProject: boolean;
  unified: ReturnType<typeof useUnifiedSettings>;
}

function FieldRow({ field, hasProject, unified }: FieldRowProps) {
  const inputId = `setting-${field.key.replace(/\./g, '-')}`;
  const value = unified.readField(field);
  // Project and Grove scopes both depend on a selected project.
  const disabled =
    (field.scope === 'grove' && !hasProject) || (field.scope === 'project' && !hasProject);

  const onChange = useCallback(
    (next: unknown) => {
      void unified.writeField(field, next).catch((err) => {
        console.error(`[settings] writeField failed: ${field.key}`, err);
      });
    },
    [unified, field],
  );

  return (
    <div className="grid grid-cols-1 gap-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={inputId} className="font-sans text-sm font-medium text-on-surface">
            {field.label}
          </label>
          <ScopeBadge scope={SCOPE_BADGE_FOR[field.scope]} />
          <code className="font-mono text-[10px] text-on-surface-variant">{field.key}</code>
        </div>
        {field.note && (
          <p className="font-sans text-xs text-on-surface-variant">{field.note}</p>
        )}
      </div>
      <div className="min-w-0">
        <FieldControl
          inputId={inputId}
          field={field}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

interface FieldControlProps {
  inputId: string;
  field: SettingField;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}

function FieldControl({ inputId, field, value, onChange, disabled }: FieldControlProps) {
  const Control = CONTROL_BY_KIND[field.kind];
  if (!Control) return null;

  switch (field.kind) {
    case 'toggle':
      return (
        <ToggleField
          id={inputId}
          value={(value as boolean | undefined) ?? false}
          onChange={(next) => onChange(next)}
          disabled={disabled}
          readonly={field.readonly}
        />
      );
    case 'select':
      return (
        <SelectField
          id={inputId}
          value={(value as string | undefined) ?? ''}
          onChange={(next) => onChange(next)}
          options={field.options ?? []}
          disabled={disabled}
          readonly={field.readonly}
        />
      );
    case 'number':
      return (
        <NumberField
          id={inputId}
          value={typeof value === 'number' ? value : 0}
          onChange={(next) => onChange(next)}
          min={field.min}
          max={field.max}
          disabled={disabled}
          readonly={field.readonly}
        />
      );
    case 'text':
      return (
        <TextField
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => onChange(next)}
          disabled={disabled}
          readonly={field.readonly}
        />
      );
    case 'list':
      return (
        <ListField
          id={inputId}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={(next) => onChange(next)}
          disabled={disabled}
          readonly={field.readonly}
        />
      );
    case 'secret':
      return (
        <SecretField
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => onChange(next)}
          disabled={disabled}
          readonly={field.readonly}
        />
      );
    default:
      return null;
  }
}
