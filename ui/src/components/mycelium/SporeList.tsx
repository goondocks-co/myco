import { useState } from 'react';
import { AlertCircle, Sprout, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { useSpores, type SporeSummary } from '../../hooks/use-spores';
import { truncate } from '../../lib/format';
import { cn } from '../../lib/cn';
import { observationTypeClass, statusClass, formatLabel } from './helpers';

/* ---------- Constants ---------- */

/** Maximum content preview length. */
const CONTENT_PREVIEW_CHARS = 120;

/** Default page size for the spore list. */
const DEFAULT_SPORES_LIMIT = 50;

/** Milliseconds per second for epoch conversion. */
const MS_PER_SECOND = 1_000;

/** Session ID preview length. */
const SESSION_ID_PREVIEW = 8;

const OBSERVATION_TYPES = ['all', 'gotcha', 'decision', 'discovery', 'trade_off', 'bug_fix'] as const;
const STATUS_OPTIONS = ['all', 'active', 'superseded', 'consolidated'] as const;

/* ---------- Helpers ---------- */

function epochToDate(epoch: number): string {
  return new Date(epoch * MS_PER_SECOND).toLocaleDateString();
}

/* ---------- Sub-components ---------- */

function SporeRow({
  spore,
  onClick,
  isSelected,
}: {
  spore: SporeSummary;
  onClick: () => void;
  isSelected: boolean;
}) {
  return (
    <Surface
      level={isSelected ? 'high' : 'low'}
      className={cn(
        'p-4 cursor-pointer transition-colors hover:bg-surface-container-high rounded-lg',
        isSelected && 'ring-1 ring-primary/30',
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
                observationTypeClass(spore.observation_type),
              )}
            >
              {formatLabel(spore.observation_type)}
            </span>
            <span
              className={cn(
                'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
                statusClass(spore.status),
              )}
            >
              {formatLabel(spore.status)}
            </span>
            {spore.importance !== null && (
              <span className="font-mono text-xs text-on-surface-variant">
                {spore.importance.toFixed(1)}
              </span>
            )}
          </div>
          <p className="font-sans text-sm text-on-surface">
            {truncate(spore.content, CONTENT_PREVIEW_CHARS)}
          </p>
        </div>
        <div className="shrink-0 text-right space-y-1">
          {spore.session_id && (
            <div className="font-mono text-xs text-on-surface-variant">
              {spore.session_id.slice(0, SESSION_ID_PREVIEW)}
            </div>
          )}
          <div className="font-sans text-xs text-on-surface-variant">
            {epochToDate(spore.created_at)}
          </div>
        </div>
      </div>
    </Surface>
  );
}

function SkeletonRow() {
  return (
    <Surface level="low" className="p-4 rounded-lg">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <div className="h-5 w-16 animate-pulse rounded bg-surface-container" />
            <div className="h-5 w-14 animate-pulse rounded bg-surface-container" />
          </div>
          <div className="h-4 w-3/4 animate-pulse rounded bg-surface-container" />
        </div>
        <div className="shrink-0 space-y-1">
          <div className="h-3 w-14 animate-pulse rounded bg-surface-container" />
          <div className="h-3 w-16 animate-pulse rounded bg-surface-container" />
        </div>
      </div>
    </Surface>
  );
}

/* ---------- Component ---------- */

export interface SporeListProps {
  onSelectSpore: (spore: SporeSummary) => void;
  selectedSporeId?: string;
}

export function SporeList({ onSelectSpore, selectedSporeId }: SporeListProps) {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(0);

  // Reset to first page when filters change
  function handleTypeChange(value: string) {
    setTypeFilter(value);
    setPage(0);
  }
  function handleStatusChange(value: string) {
    setStatusFilter(value);
    setPage(0);
  }

  const offset = page * DEFAULT_SPORES_LIMIT;

  const { data, isLoading, isError, error } = useSpores({
    type: typeFilter !== 'all' ? typeFilter : undefined,
    status: statusFilter !== 'all' ? statusFilter : undefined,
    limit: DEFAULT_SPORES_LIMIT,
    offset,
  });

  const spores = data?.spores ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / DEFAULT_SPORES_LIMIT);
  const hasPrev = page > 0;
  const hasNext = page < totalPages - 1;

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-40">
          <Select value={typeFilter} onValueChange={handleTypeChange}>
            <SelectTrigger>
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              {OBSERVATION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t === 'all' ? 'All types' : formatLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-40">
          <Select value={statusFilter} onValueChange={handleStatusChange}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'all' ? 'All statuses' : formatLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {data && (
          <span className="font-sans text-sm text-on-surface-variant ml-auto">
            {total} spore{total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Spore list */}
      {isError ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load spores</span>
          <span className="font-sans text-xs text-on-surface-variant">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {isLoading
            ? [1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)
            : spores.length === 0
            ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant">
                <Sprout className="h-8 w-8 opacity-30" />
                <span className="font-sans text-sm">No spores yet</span>
                <span className="font-sans text-xs">Spores are extracted from session activity by the agent</span>
              </div>
            )
            : spores.map((spore) => (
              <SporeRow
                key={spore.id}
                spore={spore}
                onClick={() => onSelectSpore(spore)}
                isSelected={spore.id === selectedSporeId}
              />
            ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasPrev}
            onClick={() => setPage((p) => p - 1)}
            className="gap-1 text-on-surface-variant"
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="font-mono text-xs text-on-surface-variant">
            {offset + 1}\u2013{Math.min(offset + DEFAULT_SPORES_LIMIT, total)} of {total}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasNext}
            onClick={() => setPage((p) => p + 1)}
            className="gap-1 text-on-surface-variant"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
