import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useSpores } from '../../hooks/use-spores';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { MarkdownContent } from '../ui/markdown-content';
import { cn } from '../../lib/cn';
import { formatEpochAbsolute, formatEpochAgo } from '../../lib/format';

/* ---------- Constants ---------- */

/** Upper bound on spores fetched per session — covers the long tail without paginating. */
const MAX_SESSION_SPORES = 200;

/**
 * `observation_type` is a free-form string at the DB layer, but in practice the
 * intelligence agent (vault-evolve, vault-seed) produces a known set: the six
 * direct-extraction kinds plus three synthesized kinds (`wisdom`, `pattern`,
 * `architecture`). Unmapped kinds fall through to the `secondary` tone.
 */
const KIND_TONE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  decision: 'default',
  discovery: 'default',
  wisdom: 'default',
  architecture: 'default',
  trade_off: 'secondary',
  'cross-cutting': 'secondary',
  pattern: 'secondary',
  gotcha: 'destructive',
  bug_fix: 'destructive',
};

const STATUS_TONE: Record<string, 'default' | 'outline'> = {
  active: 'default',
  superseded: 'outline',
  consolidated: 'outline',
  archived: 'outline',
};

/* ---------- Types ---------- */

export interface SessionSporesProps {
  sessionId: string;
  className?: string;
}

interface SporeCardSpore {
  id: string;
  observation_type: string;
  status: string;
  content: string;
  created_at: number;
  updated_at: number;
}

/* ---------- Sub-components ---------- */

function SporeCard({ spore }: { spore: SporeCardSpore }) {
  const [open, setOpen] = useState(false);
  const kindTone = KIND_TONE[spore.observation_type] ?? 'secondary';
  const statusTone = STATUS_TONE[spore.status] ?? 'outline';

  // Use the first non-empty line as the summary preview, stripping markdown headings.
  const preview =
    spore.content
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.replace(/^#+\s*/, '') ?? '';

  return (
    <Surface
      level="low"
      className={cn(
        'rounded-md border border-outline-variant/20 transition-colors',
        spore.status === 'superseded' && 'opacity-70',
      )}
      role="listitem"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-4 py-3 text-left hover:bg-surface-container-high/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        <div className="flex items-start gap-3">
          {open ? (
            <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-on-surface-variant" />
          ) : (
            <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-on-surface-variant" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              <Badge variant={kindTone}>{spore.observation_type}</Badge>
              <Badge variant={statusTone}>{spore.status}</Badge>
              {/* TODO(phase-3 edges): render edges badge when useSporeEdges lands */}
            </div>
            <p
              className={cn(
                'font-sans text-sm text-on-surface truncate',
                spore.status === 'superseded' && 'line-through',
              )}
            >
              {preview}
            </p>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-outline-variant/20 px-4 py-3 space-y-3">
          <MarkdownContent content={spore.content} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-on-surface-variant">
            <span title={formatEpochAbsolute(spore.created_at)}>
              Created {formatEpochAgo(spore.created_at)}
            </span>
            <span title={formatEpochAbsolute(spore.updated_at)}>
              Last updated {formatEpochAgo(spore.updated_at)}
            </span>
          </div>
        </div>
      )}
    </Surface>
  );
}

/* ---------- Component ---------- */

export function SessionSpores({ sessionId, className }: SessionSporesProps) {
  const { data, isPending, isError } = useSpores({ session_id: sessionId, limit: MAX_SESSION_SPORES });

  if (isPending) {
    return (
      <div className={cn('space-y-3 p-4', className)}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-md bg-surface-container-high" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={cn('p-4 text-sm text-tertiary', className)} role="alert">
        Failed to load spores for this session.
      </div>
    );
  }

  if (data.spores.length === 0) {
    return (
      <div className={cn('p-8 text-center text-on-surface-variant', className)}>
        <p className="font-sans text-sm italic">No spores derived from this session yet.</p>
        <p className="mt-2 font-mono text-xs">
          Spores get captured automatically as the agent learns from your prompts.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3 p-4', className)} role="list">
      {data.spores.map((spore) => (
        <SporeCard key={spore.id} spore={spore} />
      ))}
    </div>
  );
}
