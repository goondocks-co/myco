import { useState } from 'react';
import { AlertCircle, FlaskConical, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
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

function TierCard({ tier }: { tier: DigestTier }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = tier.content.length > DIGEST_PREVIEW_CHARS;
  const displayContent = isLong && !expanded
    ? tier.content.slice(0, DIGEST_PREVIEW_CHARS) + '…'
    : tier.content;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-sm font-mono">{tierLabel(tier.tier)}</CardTitle>
          <span className="text-xs text-muted-foreground">
            Generated {formatEpochAgo(tier.generated_at)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {displayContent}
        </p>
        {isLong && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground"
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
      </CardContent>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="h-3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------- Component ---------- */

export interface DigestViewProps {
  curatorId?: string;
}

export function DigestView({ curatorId }: DigestViewProps) {
  const { data, isLoading, isError, error } = useDigest(curatorId);
  const tiers = data?.tiers ?? [];

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
        <AlertCircle className="h-5 w-5" />
        <span className="text-sm">Failed to load digest</span>
        <span className="text-xs text-muted-foreground">
          {error instanceof Error ? error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  if (tiers.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
        <FlaskConical className="h-8 w-8 opacity-30" />
        <span className="text-sm">No digest generated yet</span>
        <span className="text-xs text-center max-w-xs">
          Run the curator with the digest-only task to synthesize your vault knowledge into context extracts.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {tiers.length} tier{tiers.length !== 1 ? 's' : ''} — pre-computed context extracts at different token budgets.
      </p>
      {tiers.map((tier) => (
        <TierCard key={tier.tier} tier={tier} />
      ))}
    </div>
  );
}
