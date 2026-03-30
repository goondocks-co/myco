import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, XCircle, ListChecks, ExternalLink } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { Button } from '../ui/button';
import { MarkdownContent } from '../ui/markdown-content';
import { ListToolbar, type FilterDefinition } from '../ui/list-toolbar';
import { Pagination } from '../ui/pagination';
import { useSkillCandidates, useUpdateCandidate, type SkillCandidate } from '../../hooks/use-skills';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';

/* ---------- Constants ---------- */

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

function confidenceLabel(confidence: number): { text: string; variant: 'default' | 'secondary' | 'outline' } {
  const pct = `${(confidence * 100).toFixed(0)}%`;
  if (confidence >= 0.85) return { text: pct, variant: 'default' };
  if (confidence >= 0.7) return { text: pct, variant: 'secondary' };
  return { text: pct, variant: 'outline' };
}

function timeAgo(epoch: number): string {
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusBadge(status: string) {
  switch (status) {
    case 'identified': return <Badge variant="outline">Identified</Badge>;
    case 'approved': return <Badge variant="secondary">Approved</Badge>;
    case 'generated': return <Badge variant="default">Generated</Badge>;
    case 'dismissed': return <Badge variant="outline" className="opacity-50">Dismissed</Badge>;
    default: return <Badge variant="outline">{status}</Badge>;
  }
}

/* ---------- Candidate Card ---------- */

function CandidateCard({
  candidate,
  onApprove,
  onDismiss,
  isApproving,
  isDismissing,
}: {
  candidate: SkillCandidate;
  onApprove: () => void;
  onDismiss: () => void;
  isApproving: boolean;
  isDismissing: boolean;
}) {
  const conf = confidenceLabel(candidate.confidence);
  const showActions = candidate.status === 'identified' || candidate.status === 'approved';

  return (
    <Surface level="low" className="p-5 space-y-3">
      {/* Header: topic + status + confidence + timestamp */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-serif text-lg text-on-surface leading-tight">
            {candidate.topic}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {statusBadge(candidate.status)}
          <Badge variant={conf.variant}>{conf.text}</Badge>
          <span className="font-sans text-xs text-on-surface-variant">{timeAgo(candidate.created_at)}</span>
        </div>
      </div>

      {/* Rationale */}
      <MarkdownContent
        content={candidate.rationale}
        className="text-sm text-on-surface-variant"
      />

      {/* Actions — only for identified/approved candidates */}
      {showActions && (
        <div className="flex items-center gap-2 pt-1">
          {candidate.status === 'identified' && (
            <>
              <Button
                size="sm"
                variant="default"
                onClick={onApprove}
                disabled={isApproving}
              >
                <Check className="h-3.5 w-3.5 mr-1.5" />
                {isApproving ? 'Approving...' : 'Approve'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDismiss}
                disabled={isDismissing}
                className="text-on-surface-variant"
              >
                <XCircle className="h-3.5 w-3.5 mr-1.5" />
                {isDismissing ? 'Dismissing...' : 'Dismiss'}
              </Button>
            </>
          )}
          {candidate.status === 'approved' && (
            <span className="font-sans text-xs text-on-surface-variant">
              Awaiting generation
            </span>
          )}
        </div>
      )}
    </Surface>
  );
}

/* ---------- Skeleton ---------- */

function SkeletonCard() {
  return (
    <Surface level="low" className="p-5 space-y-3">
      <div className="flex items-start justify-between">
        <div className="h-5 w-64 rounded bg-surface-container-high animate-pulse" />
        <div className="h-5 w-20 rounded bg-surface-container-high animate-pulse" />
      </div>
      <div className="space-y-1.5">
        <div className="h-3 w-full rounded bg-surface-container-high animate-pulse" />
        <div className="h-3 w-3/4 rounded bg-surface-container-high animate-pulse" />
      </div>
      <div className="h-8 w-32 rounded bg-surface-container-high animate-pulse" />
    </Surface>
  );
}

/* ---------- Component ---------- */

export function CandidateList() {
  const updateCandidate = useUpdateCandidate();
  const { searchInput, debouncedSearch, filterValues, offset, setOffset, handleSearchChange, handleFilterChange, activeFilter } = useListFilters({
    initialFilters: { status: FILTER_ALL },
  });

  const activeStatus = activeFilter('status');

  const { data, isLoading, isError, error } = useSkillCandidates({
    status: activeStatus,
    limit: DEFAULT_PAGE_SIZE,
    offset,
  });

  const candidates = data?.candidates ?? [];
  const total = data?.total ?? 0;

  // Client-side search filtering (API doesn't support search for candidates)
  const filtered = useMemo(() => {
    if (!debouncedSearch) return candidates;
    const q = debouncedSearch.toLowerCase();
    return candidates.filter(
      (c) => c.topic.toLowerCase().includes(q) || c.rationale.toLowerCase().includes(q),
    );
  }, [candidates, debouncedSearch]);

  function handleApprove(candidate: SkillCandidate) {
    updateCandidate.mutate({ id: candidate.id, status: 'approved' });
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

  if (isError) {
    return (
      <div className="space-y-3">
        {toolbar}
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load candidates</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {toolbar}
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {toolbar}

      {filtered.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 text-on-surface-variant">
          <ListChecks className="h-10 w-10 opacity-20" />
          {total === 0 && !activeStatus && !debouncedSearch ? (
            <div className="text-center space-y-2 max-w-md">
              <p className="font-sans text-sm font-medium text-on-surface">
                No skill candidates discovered yet
              </p>
              <p className="font-sans text-xs leading-relaxed">
                Candidates are procedural patterns discovered from your vault knowledge.
                Review and approve them here, then Myco generates full skills from them.
              </p>
              <div className="font-sans text-xs space-y-1 pt-1">
                <p>
                  <span className="font-medium text-on-surface">Automatic:</span>{' '}
                  The{' '}
                  <Link to="/agent?tab=tasks&task=skill-survey" className="text-primary hover:underline">
                    Skill Survey
                  </Link>{' '}
                  task runs automatically during idle periods and discovers candidates from session history, decisions, and gotchas.
                </p>
                <p>
                  <span className="font-medium text-on-surface">Manual:</span>{' '}
                  Run{' '}
                  <Link to="/agent?tab=tasks&task=skill-survey" className="inline-flex items-center gap-1 text-primary hover:underline">
                    <ExternalLink className="h-3 w-3" />
                    Skill Survey
                  </Link>{' '}
                  from the Agent page to discover candidates on demand.
                </p>
              </div>
            </div>
          ) : (
            <span className="font-sans text-sm">No matching candidates</span>
          )}
        </div>
      ) : (
        <>
          <p className="font-sans text-xs text-on-surface-variant">
            {debouncedSearch
              ? `${filtered.length} of ${total} candidate${total !== 1 ? 's' : ''}`
              : `${total} candidate${total !== 1 ? 's' : ''}`}
          </p>

          {filtered.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              onApprove={() => handleApprove(candidate)}
              onDismiss={() => handleDismiss(candidate)}
              isApproving={
                updateCandidate.isPending &&
                updateCandidate.variables?.id === candidate.id &&
                updateCandidate.variables?.status === 'approved'
              }
              isDismissing={
                updateCandidate.isPending &&
                updateCandidate.variables?.id === candidate.id &&
                updateCandidate.variables?.status === 'dismissed'
              }
            />
          ))}
        </>
      )}

      <Pagination
        total={debouncedSearch ? filtered.length : total}
        offset={offset}
        limit={DEFAULT_PAGE_SIZE}
        onPageChange={setOffset}
      />
    </div>
  );
}
