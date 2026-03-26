import { useState } from 'react';
import { AlertCircle, FlaskConical, ChevronDown, ChevronUp } from 'lucide-react';
import { Surface } from '../ui/surface';
import { Button } from '../ui/button';
import { useDigest, type DigestTier } from '../../hooks/use-spores';
import { formatEpochAgo } from '../../lib/format';

/* ---------- Constants ---------- */

/** Number of characters shown before "Show more" is needed. */
const DIGEST_PREVIEW_CHARS = 200;

/** Display labels for each tier token budget. */
const TIER_LABELS: Record<number, string> = {
  1500:  'T1500 — Compact',
  3000:  'T3000 — Brief',
  5000:  'T5000 — Standard',
  7500:  'T7500 — Extended',
  10000: 'T10000 — Full',
};

function tierLabel(tier: number): string {
  return TIER_LABELS[tier] ?? `T${tier}`;
}

/* ---------- Sub-components ---------- */

function TierPanel({ tier }: { tier: DigestTier }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = tier.content.length > DIGEST_PREVIEW_CHARS;
  const displayContent = isLong && !expanded
    ? tier.content.slice(0, DIGEST_PREVIEW_CHARS) + '\u2026'
    : tier.content;

  return (
    <Surface level="low" className="p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="font-mono text-sm text-on-surface font-medium">{tierLabel(tier.tier)}</span>
        <span className="font-sans text-xs text-on-surface-variant">
          Generated {formatEpochAgo(tier.generated_at)}
        </span>
      </div>
      <p className="font-sans text-sm text-on-surface-variant whitespace-pre-wrap leading-relaxed">
        {displayContent}
      </p>
      {isLong && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-on-surface-variant"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              Show more ({tier.content.length - DIGEST_PREVIEW_CHARS} more chars)
            </>
          )}
        </Button>
      )}
    </Surface>
  );
}

function SkeletonPanel() {
  return (
    <Surface level="low" className="p-5">
      <div className="flex items-center justify-between">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-container" />
        <div className="h-3 w-20 animate-pulse rounded bg-surface-container" />
      </div>
      <div className="space-y-2 mt-3">
        <div className="h-3 animate-pulse rounded bg-surface-container" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-surface-container" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-surface-container" />
      </div>
    </Surface>
  );
}

/* ---------- Component ---------- */

export interface DigestViewProps {
  agentId?: string;
}

export function DigestView({ agentId }: DigestViewProps) {
  const { data, isLoading, isError, error } = useDigest(agentId);
  const tiers = data?.tiers ?? [];

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => <SkeletonPanel key={i} />)}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
        <AlertCircle className="h-5 w-5" />
        <span className="font-sans text-sm">Failed to load digest</span>
        <span className="font-sans text-xs text-on-surface-variant">
          {error instanceof Error ? error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  if (tiers.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 text-on-surface-variant">
        <FlaskConical className="h-8 w-8 opacity-30" />
        <span className="font-sans text-sm">No digest generated yet</span>
        <span className="font-sans text-xs text-center max-w-xs">
          Run the agent with the digest-only task to synthesize your vault knowledge into context extracts.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="font-sans text-sm text-on-surface-variant">
        {tiers.length} tier{tiers.length !== 1 ? 's' : ''} — pre-computed context extracts at different token budgets.
      </p>
      {tiers.map((tier) => (
        <TierPanel key={tier.tier} tier={tier} />
      ))}
    </div>
  );
}
