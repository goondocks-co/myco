import { Link } from 'react-router-dom';
import { AlertCircle, Zap, XCircle, ListChecks } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { ListToolbar, type FilterDefinition } from '../ui/list-toolbar';
import { Pagination } from '../ui/pagination';
import { useSkillCandidates, useUpdateCandidate, useTriggerAgentRun, type SkillCandidate } from '../../hooks/use-skills';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import { formatEpochAgo, truncate } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const SKELETON_ROW_COUNT = 5;

const CANDIDATE_FILTERS: FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { value: FILTER_ALL, label: 'All statuses' },
      { value: 'identified', label: 'Identified' },
      { value: 'approved', label: 'Approved' },
      { value: 'generated', label: 'Generated' },
      { value: 'dismissed', label: 'Dismissed' },
    ],
  },
];

/* ---------- Helpers ---------- */

function confidenceBadgeVariant(confidence: number): 'default' | 'secondary' | 'outline' {
  if (confidence >= 0.85) return 'default';
  if (confidence >= 0.7) return 'secondary';
  return 'outline';
}

function parseSourceIds(raw: string): string[] {
  try {
    return JSON.parse(raw) ?? [];
  } catch {
    return [];
  }
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
      <td className="px-4 py-3"><div className="h-3 w-16 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-16 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-10 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-20 rounded bg-surface-container-high animate-pulse" /></td>
      <td className="px-4 py-3"><div className="h-3 w-24 rounded bg-surface-container-high animate-pulse" /></td>
    </tr>
  );
}

function CandidateTableRow({
  candidate,
  onApprove,
  onGenerate,
  onDismiss,
  isApproving,
  isGenerating,
  isDismissing,
}: {
  candidate: SkillCandidate;
  onApprove: () => void;
  onGenerate: () => void;
  onDismiss: () => void;
  isApproving: boolean;
  isGenerating: boolean;
  isDismissing: boolean;
}) {
  const sources = parseSourceIds(candidate.source_ids);
  const isIdentified = candidate.status === 'identified';
  const isApproved = candidate.status === 'approved';

  return (
    <tr className="border-b border-[var(--ghost-border)] last:border-0 hover:bg-surface-container/60 transition-all duration-150">
      {/* Topic + rationale */}
      <td className="px-4 py-3">
        <span className="font-sans text-sm font-medium text-on-surface block">
          {candidate.topic}
        </span>
        <span className="font-sans text-xs text-on-surface-variant block mt-0.5">
          {truncate(candidate.rationale, 80)}
        </span>
      </td>

      {/* Confidence */}
      <td className="px-4 py-3">
        <Badge variant={confidenceBadgeVariant(candidate.confidence)}>
          {(candidate.confidence * 100).toFixed(0)}%
        </Badge>
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        <Badge variant={candidate.status === 'dismissed' ? 'outline' : candidate.status === 'generated' ? 'secondary' : 'default'}>
          {candidate.status}
        </Badge>
      </td>

      {/* Sources count */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-on-surface-variant">
          {sources.length}
        </span>
      </td>

      {/* Created date */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-on-surface-variant">
          {formatEpochAgo(candidate.created_at)}
        </span>
      </td>

      {/* Actions — one decision at a time */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {isIdentified && (
            <>
              <button
                onClick={onApprove}
                disabled={isApproving}
                className="inline-flex items-center gap-1 px-2 py-1 rounded font-sans text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Approve this candidate for skill generation"
              >
                <ListChecks className="h-3 w-3" />
                {isApproving ? 'Approving…' : 'Approve'}
              </button>
              <button
                onClick={onDismiss}
                disabled={isDismissing}
                className="inline-flex items-center gap-1 px-1.5 py-1 rounded font-sans text-xs text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Dismiss this candidate"
              >
                <XCircle className="h-3 w-3" />
              </button>
            </>
          )}
          {isApproved && (
            <button
              onClick={onGenerate}
              disabled={isGenerating}
              className="inline-flex items-center gap-1 px-2 py-1 rounded font-sans text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Generate skill from this approved candidate"
            >
              <Zap className="h-3 w-3" />
              {isGenerating ? 'Generating…' : 'Generate Skill'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ---------- Component ---------- */

export function CandidateList() {
  const { searchInput, debouncedSearch, filterValues, offset, setOffset, handleSearchChange, handleFilterChange, activeFilter } =
    useListFilters({ initialFilters: { status: FILTER_ALL } });

  const updateCandidate = useUpdateCandidate();
  const triggerAgentRun = useTriggerAgentRun();

  const activeStatus = activeFilter('status');

  const { data, isLoading, isError, error } = useSkillCandidates({
    status: activeStatus,
    limit: DEFAULT_PAGE_SIZE,
    offset,
  });

  const candidates = data?.candidates ?? [];
  const total = data?.total ?? 0;

  // Client-side search filter (API may not support search param)
  const filtered = debouncedSearch
    ? candidates.filter(
        (c) =>
          c.topic.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          c.rationale.toLowerCase().includes(debouncedSearch.toLowerCase()),
      )
    : candidates;

  function handleApprove(candidate: SkillCandidate) {
    updateCandidate.mutate({ id: candidate.id, status: 'approved' });
  }

  function handleGenerate(candidate: SkillCandidate) {
    triggerAgentRun.mutate({
      task: 'skill-generate',
      instruction: `Generate a skill for candidate id=${candidate.id} topic="${candidate.topic}"`,
    });
  }

  function handleDismiss(candidate: SkillCandidate) {
    updateCandidate.mutate({ id: candidate.id, status: 'dismissed' });
  }

  const toolbar = (
    <ListToolbar
      searchPlaceholder="Search candidates..."
      searchValue={searchInput}
      onSearchChange={handleSearchChange}
      filters={CANDIDATE_FILTERS}
      filterValues={filterValues}
      onFilterChange={handleFilterChange}
    />
  );

  const tableHead = (
    <thead>
      <tr className="border-b border-[var(--ghost-border)] bg-surface-container/50">
        <ColHeader>Topic</ColHeader>
        <ColHeader>Confidence</ColHeader>
        <ColHeader>Status</ColHeader>
        <ColHeader>Sources</ColHeader>
        <ColHeader>Created</ColHeader>
        <ColHeader>Actions</ColHeader>
      </tr>
    </thead>
  );

  if (isError) {
    return (
      <div>
        {toolbar}
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary mt-4">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load candidates</span>
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
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant mt-4">
          <ListChecks className="h-8 w-8 opacity-30" />
          <span className="font-sans text-sm">
            {total === 0 && !debouncedSearch && !activeStatus
              ? 'No skill candidates yet'
              : 'No matching candidates'}
          </span>
          {total === 0 && !debouncedSearch && !activeStatus && (
            <span className="font-sans text-xs">
              <Link to="/agent?tab=tasks&task=skill-survey" className="text-primary hover:underline">
                Run Survey
              </Link>
              {' '}to discover skill candidates from your session history
            </span>
          )}
        </div>
      ) : (
        <Surface level="low" className="rounded-md overflow-hidden mt-4">
          <table className="w-full" aria-label="Skill candidates">
            {tableHead}
            <tbody>
              {filtered.map((candidate) => (
                <CandidateTableRow
                  key={candidate.id}
                  candidate={candidate}
                  onApprove={() => handleApprove(candidate)}
                  onGenerate={() => handleGenerate(candidate)}
                  onDismiss={() => handleDismiss(candidate)}
                  isApproving={
                    updateCandidate.isPending &&
                    updateCandidate.variables?.id === candidate.id &&
                    updateCandidate.variables?.status === 'approved'
                  }
                  isGenerating={
                    triggerAgentRun.isPending &&
                    triggerAgentRun.variables?.instruction?.includes(candidate.id)
                  }
                  isDismissing={
                    updateCandidate.isPending &&
                    updateCandidate.variables?.id === candidate.id &&
                    updateCandidate.variables?.status === 'dismissed'
                  }
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
