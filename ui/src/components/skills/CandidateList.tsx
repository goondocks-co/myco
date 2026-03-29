import { Link } from 'react-router-dom';
import { AlertCircle, Check, XCircle, ListChecks, ExternalLink } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { Button } from '../ui/button';
import { useSkillCandidates, useUpdateCandidate, type SkillCandidate } from '../../hooks/use-skills';

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

  return (
    <Surface level="low" className="p-5 space-y-3">
      {/* Header: topic + confidence + timestamp */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-serif text-lg text-on-surface leading-tight">
            {candidate.topic}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={conf.variant}>{conf.text} confidence</Badge>
          <span className="font-sans text-xs text-on-surface-variant">{timeAgo(candidate.created_at)}</span>
        </div>
      </div>

      {/* Rationale — full text, no truncation */}
      <p className="font-sans text-sm text-on-surface-variant leading-relaxed">
        {candidate.rationale}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="default"
          onClick={onApprove}
          disabled={isApproving}
        >
          <Check className="h-3.5 w-3.5 mr-1.5" />
          {isApproving ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          disabled={isDismissing}
          className="text-on-surface-variant"
        >
          <XCircle className="h-3.5 w-3.5 mr-1.5" />
          {isDismissing ? 'Dismissing…' : 'Dismiss'}
        </Button>
      </div>
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

  // Default to 'identified' — this is a review queue, not a data table
  const { data, isLoading, isError, error } = useSkillCandidates({
    status: 'identified',
    limit: 50,
  });

  const candidates = data?.candidates ?? [];
  const total = data?.total ?? 0;

  function handleApprove(candidate: SkillCandidate) {
    updateCandidate.mutate({ id: candidate.id, status: 'approved' });
  }

  function handleDismiss(candidate: SkillCandidate) {
    updateCandidate.mutate({ id: candidate.id, status: 'dismissed' });
  }

  if (isError) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
        <AlertCircle className="h-5 w-5" />
        <span className="font-sans text-sm">Failed to load candidates</span>
        <span className="font-sans text-xs text-on-surface-variant">
          {error instanceof Error ? error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-on-surface-variant">
        <ListChecks className="h-10 w-10 opacity-20" />
        <div className="text-center space-y-1">
          <p className="font-sans text-sm">
            {total === 0 ? 'No candidates awaiting review' : 'All candidates have been reviewed'}
          </p>
          <p className="font-sans text-xs">
            <Link to="/agent?tab=tasks&task=skill-survey" className="inline-flex items-center gap-1 text-primary hover:underline">
              <ExternalLink className="h-3 w-3" />
              Run Skill Candidate Survey
            </Link>
            {' '}to discover new procedural patterns
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="font-sans text-xs text-on-surface-variant">
        {total} candidate{total !== 1 ? 's' : ''} awaiting review
      </p>

      {candidates.map((candidate) => (
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
    </div>
  );
}
