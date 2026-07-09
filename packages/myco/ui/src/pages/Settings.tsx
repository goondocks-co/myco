import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type JSX } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Activity,
  Bell,
  BookOpen,
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
} from 'lucide-react';
import { Surface } from '../components/ui/surface';
import { PageHeader } from '../components/ui/page-header';
import { Badge } from '../components/ui/badge';
import { RestartGateProvider, RestartBanner } from '../components/config/restart-gate';
import { ScopeBadge } from '../components/config/ScopePill';
import { configFieldId } from '@myco/config/focus';
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
import { UpgradeCard } from '../components/operations/UpgradeCard';
import { BackupCard } from '../components/operations/BackupCard';
import { useDaemon } from '../hooks/use-daemon';
import { SETTINGS_GROUPS, type SettingField, type SettingGroup, type SettingScope } from '../settings/manifest';
import { useUnifiedSettings } from '../hooks/use-unified-settings';
import { useProjectSelection } from '../hooks/use-project-selection';
import { useAddToMachineConfigList, useRemoveFromMachineConfigList } from '../hooks/use-machine-config';
import { cn } from '../lib/cn';
import { SettingsFilterBar, type ScopeFilter } from './settings/SettingsFilterBar';

/* ---------- Icon registry ---------- */

type IconComponent = ComponentType<{ className?: string }>;

const ICONS: Record<string, IconComponent> = {
  Activity,
  Bell,
  BookOpen,
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

/**
 * Manifest entries tagged `customRender: 'card-owns'` exist for sync-test
 * coverage but the page never renders them as field rows — their owning
 * custom group renderer (e.g., AgentProviderCard) handles them. They must
 * also stay out of scope/search counts, since the user can't actually
 * tweak them as standalone rows.
 */
function isRenderableField(field: SettingField): boolean {
  return field.customRender !== 'card-owns';
}

/** Counts only the fields that actually render as standalone rows. */
function renderableFields(group: SettingGroup): SettingField[] {
  return group.fields.filter(isRenderableField);
}

function groupVisibleFields(group: SettingGroup, scope: ScopeFilter, search: string): SettingField[] {
  return renderableFields(group).filter((f) => {
    if (scope !== 'all' && f.scope !== scope) return false;
    return fieldMatchesSearch(f, search);
  });
}

/**
 * For dependsOn lookups: find the manifest entry for `key` in the same
 * scope. We walk all groups because dependent siblings sometimes live in
 * a different rendering group than the gating field (rare; defensive).
 */
function findFieldInManifest(key: string, scope: SettingScope): SettingField | undefined {
  for (const group of SETTINGS_GROUPS) {
    for (const field of group.fields) {
      if (field.key === key && field.scope === scope) return field;
    }
  }
  return undefined;
}

function groupIsVisible(
  group: SettingGroup,
  visibleFields: SettingField[],
  scope: ScopeFilter,
  search: string,
  isCustom: boolean,
): boolean {
  // Custom-card groups stay visible whenever a scope match holds. With an
  // active search we also keep them visible if the query matches any of
  // their card-owned fields by label/key — otherwise the user searches for
  // "production refs" or "harness" and gets zero results because those
  // fields are owned by AgentProviderCard / ReleaseProvenanceCard rather
  // than rendered as manifest rows.
  if (isCustom) {
    const needle = search.trim();
    const inScope = (f: SettingField) => scope === 'all' || f.scope === scope;
    if (needle.length > 0) {
      return group.fields.some((f) => inScope(f) && fieldMatchesSearch(f, needle));
    }
    if (scope === 'all') return true;
    return group.fields.some((f) => inScope(f));
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
  'upgrade',
  'backup',
  'logging',
]);

interface CustomGroupCtx {
  fields: SettingField[];
  hasProject: boolean;
  unified: ReturnType<typeof useUnifiedSettings>;
}

const CUSTOM_GROUP_RENDERERS: Record<string, (ctx: CustomGroupCtx) => JSX.Element> = {
  // Agent is hybrid: AgentProviderCard owns provider/model/runtime controls,
  // and manifest rows below it own additional agent-domain settings.
  agent: ({ fields, hasProject, unified }) => (
    <div className="space-y-4">
      <AgentProviderCard />
      {fields.length > 0 && (
        <FieldGroupBody fields={fields} hasProject={hasProject} unified={unified} />
      )}
    </div>
  ),
  embedding: () => <EmbeddingCard />,
  // Capture is hybrid: PlanCaptureCard owns plan_dirs +
  // ignore_plan_dirs_in_git with rich glob-pattern help, and the manifest
  // renders the advanced tuning fields (transcript_paths,
  // artifact_extensions, buffer_max_events) below.
  capture: ({ fields, hasProject, unified }) => (
    <div className="space-y-4">
      <PlanCaptureCard />
      {fields.length > 0 && (
        <FieldGroupBody fields={fields} hasProject={hasProject} unified={unified} />
      )}
    </div>
  ),
  'release-provenance': () => <ReleaseProvenanceCard />,
  notifications: () => <NotificationSettings />,
  // UpgradeCard owns dev-mode awareness ("Upgrades are disabled in
  // development mode"), the channel toggle, per-package status, and
  // last-check timestamp — none of which a plain SelectField for
  // daemon.update_channel would preserve.
  upgrade: () => <UpgradeCard />,
  // Backup is hybrid: manifest fields drive the config form
  // (dir, auto_interval_hours, retention.keep_*) and BackupCard adds
  // the action surface (create/preview/restore + list).
  backup: ({ fields, hasProject, unified }) => (
    <div className="space-y-4">
      <FieldGroupBody fields={fields} hasProject={hasProject} unified={unified} />
      <BackupCard embedded />
    </div>
  ),
  // Logging is hybrid: manifest fields drive log_level + log_retention_days,
  // and we tag on a read-only Machine ID row at the bottom — pre-merge this
  // lived in a standalone MachineIdentityCard on /machine/settings and is
  // the only settings surface that shows the cross-daemon identity that
  // team-sync uses for routing.
  logging: ({ fields, hasProject, unified }) => (
    <div className="space-y-4">
      <FieldGroupBody fields={fields} hasProject={hasProject} unified={unified} />
      <MachineIdentityRow />
    </div>
  ),
};

function MachineIdentityRow() {
  const daemon = useDaemon();
  const machineId = daemon.data?.context?.request?.machine_id ?? '—';
  return (
    <div className="grid grid-cols-1 gap-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-sm font-medium text-on-surface">Machine ID</span>
          <ScopeBadge scope={SCOPE_BADGE_FOR.machine} />
        </div>
        <p className="font-sans text-xs text-on-surface-variant">
          Stable identifier this daemon uses when speaking to the team worker. Read-only.
        </p>
      </div>
      <div className="min-w-0">
        <div className="flex h-9 w-full items-center rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 font-mono text-sm text-on-surface">
          {machineId}
        </div>
      </div>
    </div>
  );
}

/* ---------- Page ---------- */

export default function Settings() {
  return (
    <RestartGateProvider>
      <SettingsInner />
    </RestartGateProvider>
  );
}

function SettingsInner() {
  // The /settings route wrapper (`SettingsRoute` in App.tsx) binds a
  // ProjectSelectionBoundary to the last-known project, so this hook
  // returns the active selection whenever projects exist on the machine.
  // It only falls to null when there are zero projects — in which case
  // the page shows machine fields and the no-project banner.
  const projectSelection = useProjectSelection();
  const location = useLocation();
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
    const hash = location.hash.replace('#', '');
    if (!hash) return;
    if (!SETTINGS_GROUPS.some((g) => g.id === hash)) return;
    setActiveGroupId(hash);
    const el = document.getElementById(hash);
    if (el) {
      // Defer one tick so the layout has settled.
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'auto', block: 'start' }));
    }
  }, [location.hash]);

  // Honor `?configField=<key>` deep links from notification cards. Layout's
  // shared resolver runs on mount with an 80ms delay, but Settings's data
  // queries usually haven't resolved yet — so the field row doesn't exist
  // when the resolver looks. Re-scan once data is loaded, scroll the row
  // into view, and pulse a highlight so the user finds the field they came
  // from. Falls back to `?configSection=<id>` if no field match is found.
  useEffect(() => {
    if (unified.isLoading) return;
    const params = new URLSearchParams(location.search);
    const fieldParam = params.get('configField');
    const sectionParam = params.get('configSection');
    if (!fieldParam && !sectionParam) return;

    const HIGHLIGHT = ['ring-2', 'ring-primary/40', 'bg-primary/5'];
    const target = (() => {
      if (fieldParam) {
        let current = fieldParam;
        while (current.length > 0) {
          const el = document.getElementById(configFieldId(current));
          if (el) return el;
          const lastDot = current.lastIndexOf('.');
          if (lastDot === -1) break;
          current = current.slice(0, lastDot);
        }
      }
      if (sectionParam) {
        const el = document.getElementById(sectionParam);
        if (el) return el;
      }
      return null;
    })();

    if (!target) return;
    if (sectionParam && SETTINGS_GROUPS.some((g) => g.id === sectionParam)) {
      setActiveGroupId(sectionParam);
    }
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add(...HIGHLIGHT);
      window.setTimeout(() => target.classList.remove(...HIGHLIGHT), 2000);
    });
  }, [unified.isLoading, location.search]);

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
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-outline-variant/30 bg-surface-container/40 px-3 py-2 text-xs text-on-surface-variant">
          <span className="font-medium text-on-surface">Scopes</span>
          <span className="inline-flex items-center gap-1.5"><ScopeBadge scope="personal" /> only you, this machine</span>
          <span className="inline-flex items-center gap-1.5"><ScopeBadge scope="project" /> shared via the repo</span>
          <span className="inline-flex items-center gap-1.5"><ScopeBadge scope="grove" /> all projects in this Grove</span>
          <span className="inline-flex items-center gap-1.5"><ScopeBadge scope="machine" /> every Grove on this machine</span>
          <span className="text-on-surface-variant/70">Precedence: Personal &rsaquo; Project &rsaquo; Grove &rsaquo; Machine.</span>
        </div>
        {!hasProject && (
          <div className="mb-3 rounded-md border border-outline-variant/30 bg-surface-container/40 px-3 py-2 font-sans text-sm text-on-surface-variant">
            Select a project to edit Project and Grove settings. Machine-scoped settings are still editable below.
          </div>
        )}
        <RestartBanner />
        <SettingsFilterBar
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
          // For custom-rendered groups, count the fields that are actually
          // rendered as standalone rows — manifest entries flagged
          // customRender:'card-owns' aren't user-visible as separate rows.
          const count = isCustom ? renderableFields(group).length : visibleFields.length;
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
            <p className="font-sans text-xs text-outline">{group.desc}</p>
          </div>
          {mixedScopes && (
            <Badge variant="outline" className="text-[10px]">
              Mixed scopes
            </Badge>
          )}
        </div>

        {isCustom ? (
          <CustomGroupBody
            groupId={group.id}
            fields={visibleFields}
            hasProject={hasProject}
            unified={unified}
          />
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

function CustomGroupBody({
  groupId,
  fields,
  hasProject,
  unified,
}: { groupId: string } & CustomGroupCtx) {
  const render = CUSTOM_GROUP_RENDERERS[groupId];
  if (!render) return null;
  return <div>{render({ fields, hasProject, unified })}</div>;
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
  // `configFieldId` is the same id `Layout`'s notification deep-link
  // resolver scans for (`config-field-<path-with-dashes>`), so a link from
  // a notification card like `?configField=maintenance.auto_optimize` lands
  // on this row regardless of which group it lives in.
  const focusAnchorId = configFieldId(field.key);
  const inputId = `setting-${field.key.replace(/\./g, '-')}`;
  const value = unified.readField(field);
  // Project and Grove scopes both depend on a selected project.
  const scopeDisabled =
    (field.scope === 'grove' && !hasProject) || (field.scope === 'project' && !hasProject);
  // dependsOn: greyed out when the referenced sibling's value differs.
  // Look up the sibling within the same group so the user can see the
  // direct cause (e.g., the auto-optimize toggle right above the interval).
  const dependsOnDisabled = (() => {
    if (!field.dependsOn) return false;
    const sibling = findFieldInManifest(field.dependsOn.key, field.scope);
    if (!sibling) return false;
    const siblingValue = unified.readField(sibling);
    return siblingValue !== field.dependsOn.value;
  })();
  const disabled = scopeDisabled || dependsOnDisabled;

  const [writeError, setWriteError] = useState<string | null>(null);
  const onChange = useCallback(
    (next: unknown) => {
      setWriteError(null);
      void unified.writeField(field, next).catch((err) => {
        // Surface the failure inline — a swallowed write looks identical
        // to a successful no-op from the user's side.
        setWriteError(err instanceof Error ? err.message : String(err));
        console.error(`[settings] writeField failed: ${field.key}`, err);
      });
    },
    [unified, field],
  );

  // Machine-tier list fields use per-item list-delta ops (race-free).
  const addToMachineList = useAddToMachineConfigList();
  const removeFromMachineList = useRemoveFromMachineConfigList();
  const isMachineList = field.scope === 'machine' && field.kind === 'list';
  const onAdd = isMachineList
    ? (entry: string) => addToMachineList.mutate({ path: field.key, value: entry })
    : undefined;
  const onRemove = isMachineList
    ? (entry: string) => removeFromMachineList.mutate({ path: field.key, value: entry })
    : undefined;

  return (
    <div
      id={focusAnchorId}
      className="grid grid-cols-1 gap-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start scroll-mt-4"
    >
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
          onAdd={onAdd}
          onRemove={onRemove}
        />
        {writeError && (
          <p role="alert" className="mt-1 font-sans text-xs text-tertiary">{writeError}</p>
        )}
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
  /** Per-item add override for list fields — uses the race-free server primitive. */
  onAdd?: (entry: string) => void;
  /** Per-item remove override for list fields — uses the race-free server primitive. */
  onRemove?: (entry: string) => void;
}

function FieldControl({ inputId, field, value, onChange, disabled, onAdd, onRemove }: FieldControlProps) {
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
    case 'number': {
      // Unit conversion: when a field declares a display unit (e.g. minutes
      // for a value the daemon stores in milliseconds), the user sees the
      // friendly unit while reads/writes round-trip through the factor.
      // min/max/step are interpreted in the display unit.
      const factor = field.unit?.factor ?? 1;
      const stored = typeof value === 'number' ? value : 0;
      const display = factor === 1 ? stored : stored / factor;
      return (
        <NumberField
          id={inputId}
          value={display}
          onChange={(next) => onChange(factor === 1 ? next : next * factor)}
          min={field.min}
          max={field.max}
          step={field.step}
          suffix={field.unit?.displayUnit ?? field.suffix}
          disabled={disabled}
          readonly={field.readonly}
        />
      );
    }
    case 'text':
      return (
        <TextField
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => {
            // `nullableEmpty: true` lets a field clear its value with an
            // empty string. Committed as `undefined`, which the write layer
            // routes through the tier PUT's `clear` list — the API's only
            // supported way to unset a field.
            const trimmed = typeof next === 'string' ? next : '';
            if (field.nullableEmpty && trimmed.length === 0) {
              onChange(undefined);
            } else {
              onChange(next);
            }
          }}
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
          onAdd={onAdd}
          onRemove={onRemove}
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
