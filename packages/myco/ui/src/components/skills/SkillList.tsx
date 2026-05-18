import { Link } from 'react-router-dom';
import { AlertCircle, BookOpen } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { ListFilterBar, type FilterDefinition } from '../ui/list-filter-bar';
import { Pagination } from '../ui/pagination';
import { useSkillRecords, type SkillRecord } from '../../hooks/use-skills';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import { formatEpochRelative } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const SKELETON_ROW_COUNT = 5;

const SKILL_FILTERS: FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { value: FILTER_ALL, label: 'All statuses' },
      { value: 'active', label: 'Active' },
      { value: 'stale', label: 'Stale' },
      { value: 'retired', label: 'Retired' },
    ],
  },
];

/* ---------- Helpers ---------- */

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'stale') return 'secondary';
  return 'outline';
}

/* ---------- Sub-components ---------- */

function ColHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn('px-4 py-3 text-left font-sans text-[10px] font-medium uppercase tracking-widest text-on-surface-variant', className)}>
      {children}
    </th>
  );
}

function SkeletonTableRow() {
  return (
    <tr className="border-b border-[var(--ghost-border)]">
      <td className="px-4 py-3"><div className="h-3 w-40 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-12 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-16 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-10 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-20 rounded bg-surface-container-high animate-pulse" /></td>
    </tr>
  );
}

function SkillTableRow({
  record,
  onClick,
}: {
  record: SkillRecord;
  onClick: () => void;
}) {
  return (
    <tr
      className="border-b border-[var(--ghost-border)] last:border-0 hover:bg-surface-container/60 cursor-pointer transition-all duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 hover:shadow-[inset_3px_0_0_var(--primary)]"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      role="row"
      aria-label={`Skill: ${record.display_name}`}
    >
      {/* Name */}
      <td className="px-4 py-3">
        <span className="font-sans text-sm font-medium text-on-surface block">
          {record.display_name}
        </span>
        <span className="font-mono text-[10px] text-on-surface-variant block mt-0.5">
          {record.name}
        </span>
      </td>

      {/* Generation */}
      <td className="px-4 py-3">
        <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
          gen {record.generation}
        </Badge>
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        <Badge variant={statusBadgeVariant(record.status)}>
          {record.status}
        </Badge>
      </td>

      {/* Usage count */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-on-surface-variant">
          {record.usage_count}
        </span>
      </td>

      {/* Last evolved */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-on-surface-variant">
          {formatEpochRelative(record.updated_at)}
        </span>
      </td>
    </tr>
  );
}

/* ---------- Component ---------- */

export function SkillList({ onSelectSkill }: { onSelectSkill: (name: string) => void }) {
  const { searchInput, debouncedSearch, filterValues, offset, setOffset, handleSearchChange, handleFilterChange, activeFilter } =
    useListFilters({ initialFilters: { status: FILTER_ALL } });

  const activeStatus = activeFilter('status');

  const { data, isLoading, isError, error } = useSkillRecords({
    status: activeStatus,
    limit: DEFAULT_PAGE_SIZE,
    offset,
  });

  const records = data?.records ?? [];
  const total = data?.total ?? 0;

  // Client-side search filter
  const filtered = debouncedSearch
    ? records.filter(
        (r) =>
          r.display_name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          r.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          r.description.toLowerCase().includes(debouncedSearch.toLowerCase()),
      )
    : records;

  const toolbar = (
    <ListFilterBar
      searchPlaceholder="Search skills by name, slug, or description..."
      searchValue={searchInput}
      onSearchChange={handleSearchChange}
      filters={SKILL_FILTERS}
      filterValues={filterValues}
      onFilterChange={handleFilterChange}
      count={total > 0 ? `${total} ${total === 1 ? 'skill' : 'skills'}` : undefined}
    />
  );

  const tableHead = (
    <thead>
      <tr className="border-b border-[var(--ghost-border)] bg-surface-container/50">
        <ColHeader>Name</ColHeader>
        <ColHeader>Generation</ColHeader>
        <ColHeader>Status</ColHeader>
        <ColHeader>Usage</ColHeader>
        <ColHeader>Last Evolved</ColHeader>
      </tr>
    </thead>
  );

  if (isError) {
    return (
      <div>
        {toolbar}
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary mt-4">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load skills</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {toolbar}

      {isLoading ? (
        <Surface level="low" className="rounded-md overflow-hidden mt-4">
          <table className="w-full">
            {tableHead}
            <tbody>
              {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                <SkeletonTableRow key={i} />
              ))}
            </tbody>
          </table>
        </Surface>
      ) : filtered.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 text-on-surface-variant mt-4">
          <BookOpen className="h-10 w-10 opacity-20" />
          {total === 0 && !debouncedSearch && !activeStatus ? (
            <div className="text-center space-y-2 max-w-md">
              <p className="font-sans text-sm font-medium text-on-surface">
                No skills generated yet
              </p>
              <p className="font-sans text-xs leading-relaxed">
                Skills are project-specific procedural guides generated from your vault knowledge.
                They teach agents how to accomplish tasks in this codebase.
              </p>
              <div className="font-sans text-xs space-y-1 pt-1">
                <p>
                  <span className="font-medium text-on-surface">Automatic:</span>{' '}
                  The{' '}
                  <Link to="/agent?tab=tasks&task=skill-survey" className="text-primary hover:underline">
                    Skill Survey
                  </Link>{' '}
                  task runs automatically and discovers candidates from your vault.
                  Approve candidates in the{' '}
                  <Link to="/skills?tab=candidates" className="text-primary hover:underline">
                    Candidates tab
                  </Link>
                  , then enable the{' '}
                  <Link to="/agent?tab=tasks&task=skill-generate" className="text-primary hover:underline">
                    Skill Generate
                  </Link>{' '}
                  task to produce skills automatically.
                </p>
                <p>
                  <span className="font-medium text-on-surface">Manual:</span>{' '}
                  Run{' '}
                  <Link to="/agent?tab=tasks&task=skill-generate" className="text-primary hover:underline">
                    Skill Generate
                  </Link>{' '}
                  from the Agent page to generate a skill on demand.
                </p>
              </div>
            </div>
          ) : (
            <span className="font-sans text-sm">No matching skills</span>
          )}
        </div>
      ) : (
        <Surface level="low" className="rounded-md overflow-hidden mt-4">
          <table className="w-full" aria-label="Skills">
            {tableHead}
            <tbody>
              {filtered.map((record) => (
                <SkillTableRow
                  key={record.id}
                  record={record}
                  onClick={() => onSelectSkill(record.name)}
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
