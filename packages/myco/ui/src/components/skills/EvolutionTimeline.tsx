import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import type { SkillLineageEntry } from '../../hooks/use-skills';
import { formatEpochRelative } from '../../lib/format';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const ACTION_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'warning' | 'outline'> = {
  created: 'default',
  updated: 'secondary',
  split: 'warning',
  retired: 'outline',
};

/* ---------- Sub-components ---------- */

function TimelineEntry({ entry }: { entry: SkillLineageEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative pl-6">
      {/* Timeline dot */}
      <div className="absolute left-0 top-2 h-2.5 w-2.5 rounded-full border-2 border-outline-variant bg-surface-container" />

      <button
        type="button"
        className="w-full text-left group cursor-pointer"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
            v{entry.generation}
          </Badge>

          <Badge variant={ACTION_BADGE_VARIANT[entry.action] ?? 'outline'}>
            {entry.action}
          </Badge>

          <span className="font-mono text-[10px] text-on-surface-variant ml-auto shrink-0">
            {formatEpochRelative(entry.created_at)}
          </span>

          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 text-on-surface-variant transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        </div>

        {entry.rationale && (
          <p className="font-sans text-sm text-on-surface-variant mt-1 leading-relaxed">
            {entry.rationale}
          </p>
        )}
      </button>

      {expanded && entry.content_snapshot && (
        <Surface level="lowest" className="mt-2 p-3 overflow-auto max-h-96">
          <pre className="font-mono text-xs text-on-surface whitespace-pre-wrap break-words">
            {entry.content_snapshot}
          </pre>
        </Surface>
      )}
    </div>
  );
}

/* ---------- Component ---------- */

interface EvolutionTimelineProps {
  entries: SkillLineageEntry[];
}

export function EvolutionTimeline({ entries }: EvolutionTimelineProps) {
  if (entries.length === 0) {
    return (
      <p className="font-sans text-sm text-on-surface-variant py-4">
        No evolution history.
      </p>
    );
  }

  return (
    <div className="relative space-y-4">
      {/* Vertical connecting line */}
      <div className="absolute left-[4.5px] top-2 bottom-2 w-px bg-outline-variant/30" />

      {entries.map((entry) => (
        <TimelineEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
