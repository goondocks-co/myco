import { useMemo } from 'react';
import { AlertCircle, FileSearch } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { ListToolbar, type FilterDefinition } from '../ui/list-toolbar';
import { Pagination } from '../ui/pagination';
import {
  useCanopyEntries,
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
const LANGUAGE_OPTIONS = [
  { value: FILTER_ALL,    label: 'All languages' },
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

const ENTRY_FILTERS: FilterDefinition[] = [
  { key: 'language',  label: 'Language',  options: LANGUAGE_OPTIONS },
  { key: 'described', label: 'Described', options: TRISTATE_OPTIONS },
  { key: 'embedded',  label: 'Embedded',  options: TRISTATE_OPTIONS },
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

function ColHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
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
    initialFilters: {
      language: FILTER_ALL,
      described: FILTER_ALL,
      embedded: FILTER_ALL,
    },
  });

  const queryArgs = useMemo(() => ({
    limit: DEFAULT_PAGE_SIZE,
    offset,
    language: activeFilter('language'),
    described: tristateToBool(activeFilter('described')),
    embedded: tristateToBool(activeFilter('embedded')),
    // Path filter is debounced via the search input.
    path_prefix: debouncedSearch,
  }), [offset, activeFilter, debouncedSearch]);

  const { data, isLoading, isError, error } = useCanopyEntries(queryArgs);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  const toolbar = (
    <ListToolbar
      searchPlaceholder="Filter by path prefix..."
      searchValue={searchInput}
      onSearchChange={handleSearchChange}
      filters={ENTRY_FILTERS}
      filterValues={filterValues}
      onFilterChange={handleFilterChange}
    />
  );

  const tableHead = (
    <thead>
      <tr className="border-b border-[var(--ghost-border)] bg-surface-container/50">
        <ColHeader>Path</ColHeader>
        <ColHeader>Language</ColHeader>
        <ColHeader>Described</ColHeader>
        <ColHeader>Embedded</ColHeader>
        <ColHeader>Last Described</ColHeader>
        <ColHeader>Tokens</ColHeader>
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
