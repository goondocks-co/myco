import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, XCircle, ListChecks, ExternalLink, Clock } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { Button } from '../ui/button';
import { MarkdownContent } from '../ui/markdown-content';
import { ListToolbar, type FilterDefinition } from '../ui/list-toolbar';
import { Pagination } from '../ui/pagination';
import { useSkillCandidates, useUpdateCandidate, type SkillCandidate } from '../../hooks/use-skills';
import { useListFilters, FILTER_ALL } from '../../hooks/use-list-filters';
import { DEFAULT_PAGE_SIZE } from '../../lib/constants';
import {
  CANDIDATE_STATUS,
  PIPELINE_FILTER_VALUE,
  type SkillCandidateStatus,
} from '../../lib/skill-candidate-status';

/* ---------- Constants ---------- */

const CANDIDATE_FILTERS: FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { value: FILTER_ALL, label: 'All statuses' },
      { value: CANDIDATE_STATUS.IDENTIFIED, label: 'Identified' },
      { value: PIPELINE_FILTER_VALUE, label: 'Approved & generated' },
      { value: CANDIDATE_STATUS.APPROVED, label: 'Awaiting generation' },
      { value: CANDIDATE_STATUS.GENERATED, label: 'Generated' },
      { value: CANDIDATE_STATUS.DEFERRED, label: 'Deferred' },
      { value: CANDIDATE_STATUS.DISMISSED, label: 'Dismissed' },
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
  // Narrow string → SkillCandidateStatus when possible so an exhaustive
  // switch enforces that every known status has a badge. The string
  // default catches values from the wire that the UI types don't
  // recognize (e.g. a backend-only status that hasn't been mirrored
  // here yet) — better to render the raw value than crash.
  switch (status as SkillCandidateStatus) {
    case CANDIDATE_STATUS.IDENTIFIED: return <Badge variant="outline">Identified</Badge>;
    case CANDIDATE_STATUS.APPROVED: return <Badge variant="secondary">Awaiting generation</Badge>;
    case CANDIDATE_STATUS.GENERATED: return <Badge variant="default">Generated</Badge>;
    case CANDIDATE_STATUS.DEFERRED: return <Badge variant="outline">Deferred</Badge>;
    case CANDIDATE_STATUS.DISMISSED: return <Badge variant="outline" className="opacity-50">Dismissed</Badge>;
    default: {
      // If the value matched a SkillCandidateStatus case it was handled
      // above; reaching here means the wire value is outside the known
      // set. The `never` assertion fires at compile time when a new
      // status is added to the union without a corresponding case.
      const _exhaustive: never = status as never;
      void _exhaustive;
      return <Badge variant="outline">{status}</Badge>;
    }
  }
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sourceRefLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as { id?: unknown; type?: unknown };
  if (typeof ref.id !== 'string' || typeof ref.type !== 'string') return null;
  return `${ref.type}:${ref.id}`;
}

function EvidenceDetailList({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="min-w-0">
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className="mt-1 flex flex-wrap gap-1.5">
        {values.map((value) => (
          <code
            key={value}
            className="max-w-full truncate rounded border border-outline-variant/40 bg-surface-container px-1.5 py-0.5 font-mono text-[11px] text-on-surface"
            title={value}
          >
            {value}
          </code>
        ))}
      </dd>
    </div>
  );
}

function CandidateQualityMetadata({ candidate }: { candidate: SkillCandidate }) {
  const sourceRefs = parseJsonArray(candidate.source_ids).map(sourceRefLabel).filter((label): label is string => Boolean(label));
  const failures = parseJsonArray(candidate.quality_failures).filter((value): value is string => typeof value === 'string');
  const coverageMatches = parseJsonArray(candidate.coverage_matches).filter((value): value is string => typeof value === 'string');
  const qualityScore = typeof candidate.quality_score === 'number' && Number.isFinite(candidate.quality_score)
    ? candidate.quality_score
    : null;
  const hasMetadata =
    candidate.evidence_bundle_id ||
    qualityScore !== null ||
    failures.length > 0 ||
    coverageMatches.length > 0 ||
    sourceRefs.length > 0 ||
    candidate.reconciliation_reason;

  if (!hasMetadata) return null;

  return (
    <details className="group font-sans text-xs text-on-surface-variant">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 [&::-webkit-details-marker]:hidden">
        {qualityScore !== null && (
          <Badge variant={qualityScore >= 0.7 ? 'secondary' : 'outline'}>
            Quality {(qualityScore * 100).toFixed(0)}%
          </Badge>
        )}
        {candidate.evidence_bundle_id && (
          <Badge variant="outline" className="max-w-[240px] truncate" title={candidate.evidence_bundle_id}>
            Bundle {candidate.evidence_bundle_id}
          </Badge>
        )}
        {sourceRefs.length > 0 && (
          <Badge variant="outline" title={sourceRefs.join(', ')}>
            {sourceRefs.length} source{sourceRefs.length === 1 ? '' : 's'}
          </Badge>
        )}
        {coverageMatches.length > 0 && (
          <Badge variant="outline" title={coverageMatches.join(', ')}>
            {coverageMatches.length} overlap{coverageMatches.length === 1 ? '' : 's'}
          </Badge>
        )}
        {failures.slice(0, 3).map((failure) => (
          <Badge key={failure} variant="outline" className="opacity-70">
            {failure}
          </Badge>
        ))}
        {failures.length > 3 && (
          <Badge variant="outline" className="opacity-70">
            +{failures.length - 3} more
          </Badge>
        )}
        <span className="text-on-surface-variant underline-offset-2 group-open:underline">
          Evidence details
        </span>
      </summary>

      <dl className="mt-3 grid gap-3 border-l border-outline-variant/40 pl-3 sm:grid-cols-2">
        {candidate.evidence_bundle_id && (
          <EvidenceDetailList label="Bundle" values={[candidate.evidence_bundle_id]} />
        )}
        <EvidenceDetailList label="Sources" values={sourceRefs} />
        <EvidenceDetailList label="Coverage matches" values={coverageMatches} />
        <EvidenceDetailList label="Quality failures" values={failures} />
        {candidate.reconciliation_reason && (
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-on-surface-variant">Latest reconciliation</dt>
            <dd className="mt-1 leading-relaxed text-on-surface">
              {candidate.reconciliation_reason}
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}

/* ---------- Candidate Card ---------- */

function CandidateCard({
  candidate,
  onApprove,
  onDefer,
  onDismiss,
  isApproving,
  isDeferring,
  isDismissing,
}: {
  candidate: SkillCandidate;
  onApprove: () => void;
  onDefer: () => void;
  onDismiss: () => void;
  isApproving: boolean;
  isDeferring: boolean;
  isDismissing: boolean;
}) {
  const conf = confidenceLabel(candidate.confidence);
  const showActions =
    candidate.status === CANDIDATE_STATUS.IDENTIFIED ||
    candidate.status === CANDIDATE_STATUS.APPROVED;

  return (
    <Surface level="low" className="p-5 space-y-3">
      {/* Header: topic + status + confidence + timestamp */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-serif text-lg text-on-surface leading-tight">
            {candidate.topic}
          </h3>
          {/* Approval audit line — renders whenever approved_at is set,
              so the user can trace "I approved this Xd ago" even after
              the candidate has advanced to generated. */}
          {candidate.approved_at !== null && (
            <p className="font-sans text-xs text-on-surface-variant mt-1">
              Approved {timeAgo(candidate.approved_at)}
              {candidate.status === CANDIDATE_STATUS.GENERATED && ' · generated'}
            </p>
          )}
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

      <CandidateQualityMetadata candidate={candidate} />

      {/* Actions — only for identified/approved candidates */}
      {showActions && (
        <div className="flex items-center gap-2 pt-1">
          {candidate.status === CANDIDATE_STATUS.IDENTIFIED && (
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
                onClick={onDefer}
                disabled={isDeferring}
                className="text-on-surface-variant"
              >
                <Clock className="h-3.5 w-3.5 mr-1.5" />
                {isDeferring ? 'Deferring...' : 'Defer'}
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
          {candidate.status === CANDIDATE_STATUS.APPROVED && (
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
    initialFilters: { status: CANDIDATE_STATUS.IDENTIFIED },
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
    updateCandidate.mutate({ id: candidate.id, status: CANDIDATE_STATUS.APPROVED });
  }

  function handleDefer(candidate: SkillCandidate) {
    updateCandidate.mutate({ id: candidate.id, status: CANDIDATE_STATUS.DEFERRED });
  }

  function handleDismiss(candidate: SkillCandidate) {
    updateCandidate.mutate({ id: candidate.id, status: CANDIDATE_STATUS.DISMISSED });
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
              onDefer={() => handleDefer(candidate)}
              onDismiss={() => handleDismiss(candidate)}
              isApproving={
                updateCandidate.isPending &&
                updateCandidate.variables?.id === candidate.id &&
                updateCandidate.variables?.status === CANDIDATE_STATUS.APPROVED
              }
              isDeferring={
                updateCandidate.isPending &&
                updateCandidate.variables?.id === candidate.id &&
                updateCandidate.variables?.status === CANDIDATE_STATUS.DEFERRED
              }
              isDismissing={
                updateCandidate.isPending &&
                updateCandidate.variables?.id === candidate.id &&
                updateCandidate.variables?.status === CANDIDATE_STATUS.DISMISSED
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
