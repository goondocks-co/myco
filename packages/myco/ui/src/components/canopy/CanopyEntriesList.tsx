import { useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, FileSearch, Search } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Surface } from '../ui/surface';
import { Pagination } from '../ui/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  useCanopyEntries,
  type CanopyEntriesSortBy,
  type CanopyEntriesSortDir,
  type CanopyEntryRow,
} from '../../hooks/use-canopy';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import { formatEpochRelative } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const SKELETON_ROW_COUNT = 6;

/**
 * Three-state filters share the same shape: 'all' (sentinel), 'yes', 'no'.
 * 'yes'/'no' map to `true`/`false` on the backend boolean params.
 */
const TRISTATE_OPTIONS = [
  { value: FILTER_ALL, label: 'All' },
  { value: 'yes', label: 'Yes' },
  { value: 'no',  label: 'No' },
];

/**
 * The language list is intentionally hardcoded — the backend doesn't expose
 * a "distinct languages" endpoint and pulling it from the current page is
 * misleading (you'd never see languages outside the current filter slice).
 * This is the canonical set the scanner emits.
 */
// "All" rather than "All languages" — the inline LANGUAGE label already
// names the column, so the long form duplicated context and forced the
// trigger wider than every other filter.
const LANGUAGE_OPTIONS = [
  { value: FILTER_ALL,    label: 'All' },
  { value: 'typescript',  label: 'TypeScript' },
  { value: 'javascript',  label: 'JavaScript' },
  { value: 'tsx',         label: 'TSX' },
  { value: 'jsx',         label: 'JSX' },
  { value: 'python',      label: 'Python' },
  { value: 'rust',        label: 'Rust' },
  { value: 'go',          label: 'Go' },
  { value: 'json',        label: 'JSON' },
  { value: 'yaml',        label: 'YAML' },
  { value: 'markdown',    label: 'Markdown' },
  { value: 'shell',       label: 'Shell' },
  { value: 'sql',         label: 'SQL' },
];

/**
 * Sortable column definitions. Each entry pairs the API sort_by token with
 * the human-readable header label. The column header click handler maps from
 * the column id to the sort_by; columns not in this list render as plain
 * text headers (no chevron, no click affordance).
 */
const SORT_COLUMNS: Array<{ id: CanopyEntriesSortBy; label: string }> = [
  { id: 'path',           label: 'Path' },
  { id: 'language',       label: 'Language' },
  { id: 'embedded',       label: 'Embedded' },
  { id: 'llm_updated_at', label: 'Last Described' },
  { id: 'token_estimate', label: 'Tokens' },
];

/* ---------- Helpers ---------- */

function tristateToBool(value: string | undefined): boolean | undefined {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return undefined;
}

function yesNoBadge(flag: boolean): React.ReactNode {
  return (
    <Badge variant={flag ? 'default' : 'secondary'}>
      {flag ? 'Yes' : 'No'}
    </Badge>
  );
}

/* ---------- Sub-components ---------- */

/**
 * A labeled dropdown — the visible label is the difference from `ListToolbar`,
 * which only surfaces the label as a placeholder (and never when a value is
 * selected). Chris's smoke-test review flagged the bare "All / Yes / No"
 * dropdowns as ambiguous, so we render the column purpose inline.
 */
function FilterDropdown({
  label,
  value,
  options,
  onValueChange,
  triggerClassName = 'w-32',
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onValueChange: (value: string) => void;
  /** Tailwind width class for the trigger. Override when the longest label
   *  wraps or truncates at the default 128px (e.g. "All languages"). */
  triggerClassName?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-on-surface-variant">
      <span className="font-sans text-xs uppercase tracking-wider">
        {label}
      </span>
      <div className={`${triggerClassName} shrink-0`}>
        <Select value={value} onValueChange={onValueChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </label>
  );
}

function ColHeader({
  children,
  className,
  sortKey,
  activeSort,
  activeDir,
  onSort,
}: {
  children: React.ReactNode;
  className?: string;
  sortKey?: CanopyEntriesSortBy;
  activeSort?: CanopyEntriesSortBy;
  activeDir?: CanopyEntriesSortDir;
  onSort?: (key: CanopyEntriesSortBy) => void;
}) {
  const sortable = sortKey !== undefined && onSort !== undefined;
  const isActive = sortable && activeSort === sortKey;
  if (!sortable) {
    return (
      <th
        className={cn(
          'px-4 py-3 text-left font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant',
          className,
        )}
      >
        {children}
      </th>
    );
  }
  return (
    <th
      className={cn(
        'px-4 py-3 text-left font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant',
        className,
      )}
      aria-sort={isActive ? (activeDir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'flex items-center gap-1 uppercase tracking-widest text-[10px] font-medium transition-colors',
          isActive ? 'text-on-surface' : 'text-on-surface-variant hover:text-on-surface',
        )}
        aria-label={`Sort by ${String(children)}`}
      >
        <span>{children}</span>
        {isActive ? (
          activeDir === 'desc' ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronUp className="h-3 w-3" />
          )
        ) : (
          <ChevronDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </th>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-[var(--ghost-border)]">
      <td className="px-4 py-3"><div className="h-3 w-64 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-16 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-10 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-10 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-20 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-12 rounded bg-surface-container-high animate-pulse" /></td>
    </tr>
  );
}

function EntryRow({
  entry,
  selected,
  onClick,
}: {
  entry: CanopyEntryRow;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <tr
      className={cn(
        'border-b border-[var(--ghost-border)] last:border-0 cursor-pointer transition-all duration-150',
        'hover:bg-surface-container/60 hover:shadow-[inset_3px_0_0_var(--primary)]',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
        selected && 'bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]',
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      role="row"
      aria-selected={selected}
      aria-label={`Canopy entry: ${entry.path}`}
      data-testid={`canopy-entry-row-${entry.path}`}
    >
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-on-surface block truncate" title={entry.path}>
          {entry.path}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="font-sans text-xs text-on-surface-variant">
          {entry.language ?? '—'}
        </span>
      </td>
      <td className="px-4 py-3">
        {yesNoBadge(entry.llm_description !== null)}
      </td>
      <td className="px-4 py-3">
        {yesNoBadge(entry.embedded === 1)}
      </td>
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-on-surface-variant">
          {formatEpochRelative(entry.llm_updated_at)}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-on-surface-variant">
          {entry.token_estimate.toLocaleString()}
        </span>
      </td>
    </tr>
  );
}

/* ---------- Component ---------- */

export interface CanopyEntriesListProps {
  selectedPath: string | undefined;
  onSelectPath: (path: string) => void;
}

export function CanopyEntriesList({ selectedPath, onSelectPath }: CanopyEntriesListProps) {
  const {
    searchInput,
    debouncedSearch,
    filterValues,
    offset,
    setOffset,
    handleSearchChange,
    handleFilterChange,
    activeFilter,
  } = useListFilters({
    // Embedded was a third tristate filter; pulled because there's no user
    // action it gates — embedding follows description automatically. The
    // Embedded column on the table still surfaces per-row state for the
    // rare drift case.
    initialFilters: {
      language: FILTER_ALL,
      described: FILTER_ALL,
    },
  });

  const [sortBy, setSortBy] = useState<CanopyEntriesSortBy>('llm_updated_at');
  const [sortDir, setSortDir] = useState<CanopyEntriesSortDir>('desc');
  const handleSort = (key: CanopyEntriesSortBy) => {
    if (key === sortBy) {
      // Same column — toggle direction.
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  };

  const queryArgs = useMemo(() => ({
    limit: DEFAULT_PAGE_SIZE,
    offset,
    language: activeFilter('language'),
    described: tristateToBool(activeFilter('described')),
    // Free-text search across path AND llm_description.
    q: debouncedSearch,
    sort_by: sortBy,
    sort_dir: sortDir,
  }), [offset, activeFilter, debouncedSearch, sortBy, sortDir]);

  const { data, isLoading, isError, error } = useCanopyEntries(queryArgs);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  const toolbar = (
    <Surface level="bright" className="flex flex-wrap items-center gap-3 px-4 py-2 rounded-md">
      <Search className="h-3.5 w-3.5 text-on-surface-variant shrink-0" />
      <Input
        placeholder="Search files (path or description)…"
        value={searchInput}
        onChange={(e) => handleSearchChange(e.target.value)}
        className="bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-auto py-0 font-sans text-sm flex-1 min-w-[180px]"
        aria-label="Search files"
      />
      <FilterDropdown
        label="Language"
        value={filterValues.language ?? FILTER_ALL}
        options={LANGUAGE_OPTIONS}
        onValueChange={(v) => handleFilterChange('language', v)}
      />
      <FilterDropdown
        label="Described"
        value={filterValues.described ?? FILTER_ALL}
        options={TRISTATE_OPTIONS}
        onValueChange={(v) => handleFilterChange('described', v)}
      />
    </Surface>
  );

  const tableHead = (
    <thead>
      <tr className="border-b border-[var(--ghost-border)] bg-surface-container/50">
        {SORT_COLUMNS.map((col, idx) => {
          // The "Described" column lives between Language and Embedded in the
          // visual layout but isn't sortable on its own — described===null
          // is already filterable and a separate sort would surprise users.
          // Re-inject it here at idx===2 so column order stays in sync with
          // the table body.
          const elements: React.ReactNode[] = [
            <ColHeader
              key={col.id}
              sortKey={col.id}
              activeSort={sortBy}
              activeDir={sortDir}
              onSort={handleSort}
            >
              {col.label}
            </ColHeader>,
          ];
          if (col.id === 'language') {
            elements.push(
              <ColHeader key="described">Described</ColHeader>,
            );
          }
          return elements;
        })}
      </tr>
    </thead>
  );

  if (isError) {
    return (
      <div className="space-y-3">
        {toolbar}
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load canopy entries</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {toolbar}

      {isLoading ? (
        <Surface level="low" className="rounded-md overflow-hidden">
          <table className="w-full">
            {tableHead}
            <tbody>
              {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                <SkeletonRow key={i} />
              ))}
            </tbody>
          </table>
        </Surface>
      ) : rows.length === 0 ? (
        <div
          className="flex h-48 flex-col items-center justify-center gap-3 text-on-surface-variant"
          data-testid="canopy-entries-empty"
        >
          <FileSearch className="h-10 w-10 opacity-20" />
          <span className="font-sans text-sm">
            {total === 0
              ? 'No canopy entries match the current filters.'
              : 'No matching entries on this page.'}
          </span>
        </div>
      ) : (
        <Surface level="low" className="rounded-md overflow-hidden">
          <table className="w-full" aria-label="Canopy entries">
            {tableHead}
            <tbody>
              {rows.map((entry) => (
                <EntryRow
                  key={entry.path}
                  entry={entry}
                  selected={entry.path === selectedPath}
                  onClick={() => onSelectPath(entry.path)}
                />
              ))}
            </tbody>
          </table>
        </Surface>
      )}

      <Pagination
        total={total}
        offset={offset}
        limit={DEFAULT_PAGE_SIZE}
        onPageChange={setOffset}
      />
    </div>
  );
}
