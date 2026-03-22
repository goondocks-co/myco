import { useState } from 'react';
import { AlertCircle, Sprout } from 'lucide-react';
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
    <tr
      className={cn(
        'border-b border-border last:border-0 hover:bg-accent/50 cursor-pointer transition-colors',
        isSelected && 'bg-accent',
      )}
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <span
          className={cn(
            'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold',
            observationTypeClass(spore.observation_type),
          )}
        >
          {formatLabel(spore.observation_type)}
        </span>
      </td>
      <td className="px-4 py-3">
        <span
          className={cn(
            'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold',
            statusClass(spore.status),
          )}
        >
          {formatLabel(spore.status)}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground text-center">
        {spore.importance !== null ? spore.importance.toFixed(1) : '—'}
      </td>
      <td className="px-4 py-3 max-w-xs">
        <span className="text-sm text-foreground">
          {truncate(spore.content, CONTENT_PREVIEW_CHARS)}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
        {spore.session_id ? spore.session_id.slice(0, 8) : '—'}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {epochToDate(spore.created_at)}
      </td>
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-border">
      {[80, 60, 40, 300, 60, 80].map((w, i) => (
        <td key={i} className="px-4 py-3">
          <div
            className="h-4 animate-pulse rounded bg-muted"
            style={{ width: `${w}px` }}
          />
        </td>
      ))}
    </tr>
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

  const { data, isLoading, isError, error } = useSpores({
    type: typeFilter !== 'all' ? typeFilter : undefined,
    status: statusFilter !== 'all' ? statusFilter : undefined,
    limit: DEFAULT_SPORES_LIMIT,
  });

  const spores = data?.spores ?? [];

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-40">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
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
          <Select value={statusFilter} onValueChange={setStatusFilter}>
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
          <span className="text-sm text-muted-foreground ml-auto">
            {data.total} spore{data.total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Table */}
      {isError ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span className="text-sm">Failed to load spores</span>
          <span className="text-xs text-muted-foreground">
            {error instanceof Error ? error.message : 'Unknown error'}
          </span>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                {['Type', 'Status', 'Imp.', 'Content', 'Session', 'Date'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? [1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)
                : spores.length === 0
                ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
                        <Sprout className="h-8 w-8 opacity-30" />
                        <span className="text-sm">No spores yet</span>
                        <span className="text-xs">Spores are extracted from session activity by curators</span>
                      </div>
                    </td>
                  </tr>
                )
                : spores.map((spore) => (
                  <SporeRow
                    key={spore.id}
                    spore={spore}
                    onClick={() => onSelectSpore(spore)}
                    isSelected={spore.id === selectedSporeId}
                  />
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination hint */}
      {data && data.total > DEFAULT_SPORES_LIMIT && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {spores.length} of {data.total} spores
        </p>
      )}
    </div>
  );
}
