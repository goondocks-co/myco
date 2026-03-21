import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
  Loader2,
  Sprout,
  Package,
  RotateCcw,
} from 'lucide-react';
import { fetchJson, postJson } from '../../lib/api';
import { usePowerQuery } from '../../hooks/use-power-query';
import { POLL_INTERVALS } from '../../lib/constants';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { cn } from '../../lib/cn';
import { WorkItemDetail } from './WorkItemDetail';

/* ---------- Constants ---------- */

const ITEMS_PAGE_SIZE = 50;
const FILTER_ALL = 'all';

const STAGES = ['capture', 'extraction', 'embedding', 'consolidation', 'digest'] as const;
const STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'blocked', 'poisoned'] as const;
const TYPES = ['session', 'spore', 'artifact'] as const;

const STAGE_LABELS: Record<string, string> = {
  capture: 'Capture',
  extraction: 'Extraction',
  embedding: 'Embedding',
  consolidation: 'Consolidation',
  digest: 'Digest',
};

const STATUS_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  succeeded: 'default',
  pending: 'secondary',
  processing: 'outline',
  failed: 'destructive',
  blocked: 'destructive',
  poisoned: 'destructive',
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  succeeded: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  pending: '',
  processing: 'border-amber-400/50 text-amber-600 dark:text-amber-400',
  failed: '',
  blocked: 'bg-red-500/10',
  poisoned: 'bg-red-600/15 text-red-700 dark:text-red-400 border-red-600/30',
};

const TYPE_ICON: Record<string, typeof FileText> = {
  session: FileText,
  spore: Sprout,
  artifact: Package,
};

const ITEM_ID_TRUNCATE_LENGTH = 12;

/* ---------- Types ---------- */

interface PipelineItem {
  id: string;
  item_type: string;
  source_path: string | null;
  stage: string;
  status: string;
  attempt: number;
  error_type: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface ItemsResponse {
  items: PipelineItem[];
  total: number;
}

/* ---------- Helpers ---------- */

function truncateId(id: string): string {
  return id.length > ITEM_ID_TRUNCATE_LENGTH
    ? id.slice(0, ITEM_ID_TRUNCATE_LENGTH) + '...'
    : id;
}

/* ---------- Filter Bar ---------- */

function FilterBar({
  stage,
  status,
  type,
  onStageChange,
  onStatusChange,
  onTypeChange,
}: {
  stage: string;
  status: string;
  type: string;
  onStageChange: (v: string) => void;
  onStatusChange: (v: string) => void;
  onTypeChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={stage} onValueChange={onStageChange}>
        <SelectTrigger className="w-36 h-8 text-xs">
          <SelectValue placeholder="Stage" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FILTER_ALL}>All stages</SelectItem>
          {STAGES.map((s) => (
            <SelectItem key={s} value={s}>{STAGE_LABELS[s] ?? s}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={status} onValueChange={onStatusChange}>
        <SelectTrigger className="w-36 h-8 text-xs">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FILTER_ALL}>All statuses</SelectItem>
          {STATUSES.map((s) => (
            <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={type} onValueChange={onTypeChange}>
        <SelectTrigger className="w-36 h-8 text-xs">
          <SelectValue placeholder="Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FILTER_ALL}>All types</SelectItem>
          {TYPES.map((t) => (
            <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ---------- Pagination ---------- */

function Pagination({
  total,
  offset,
  pageSize,
  onPrevious,
  onNext,
}: {
  total: number;
  offset: number;
  pageSize: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const currentPage = Math.floor(offset / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">
        {total} item{total !== 1 ? 's' : ''}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={offset === 0}
          onClick={onPrevious}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground px-2">
          {currentPage} / {totalPages}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={offset + pageSize >= total}
          onClick={onNext}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/* ---------- Item Row ---------- */

function ItemRow({
  item,
  isExpanded,
  onToggle,
}: {
  item: PipelineItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const TypeIcon = TYPE_ICON[item.item_type] ?? FileText;
  const statusVariant = STATUS_BADGE_VARIANT[item.status] ?? 'secondary';
  const statusClass = STATUS_BADGE_CLASS[item.status] ?? '';

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50"
        onClick={onToggle}
      >
        {/* Expand chevron */}
        {isExpanded ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}

        {/* Type icon */}
        <TypeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />

        {/* ID */}
        <span className="font-mono text-xs text-foreground" title={item.id}>
          {truncateId(item.id)}
        </span>

        {/* Stage */}
        <span className="text-xs text-muted-foreground">
          {STAGE_LABELS[item.stage] ?? item.stage}
        </span>

        {/* Status badge */}
        <Badge
          variant={statusVariant}
          className={cn('ml-auto text-[10px] px-1.5 py-0', statusClass)}
        >
          {item.status}
        </Badge>

        {/* Attempt count if > 1 */}
        {item.attempt > 1 && (
          <span className="text-[10px] font-mono text-muted-foreground">
            x{item.attempt}
          </span>
        )}
      </button>

      {/* Error preview (shown in row for failed/poisoned) */}
      {!isExpanded && item.error_message && (
        <div className="px-3 pb-2 pl-[60px]">
          <p className="truncate text-xs text-destructive/70">{item.error_message}</p>
        </div>
      )}

      {/* Expanded detail */}
      {isExpanded && (
        <div className="px-3 pb-3 pl-8">
          <WorkItemDetail itemId={item.id} itemType={item.item_type} />
        </div>
      )}
    </div>
  );
}

/* ---------- Retry All Banner ---------- */

function RetryAllBanner({ onRetried }: { onRetried: () => void }) {
  const [retrying, setRetrying] = useState(false);

  const handleRetryAll = async () => {
    setRetrying(true);
    try {
      await postJson('/pipeline/retry-all', {});
      onRetried();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 text-xs"
      disabled={retrying}
      onClick={handleRetryAll}
    >
      {retrying ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <RotateCcw className="h-3 w-3" />
      )}
      Retry All Poisoned
    </Button>
  );
}

/* ---------- Main Component ---------- */

export function WorkItemList() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Read initial filter from URL query params (e.g., ?stage=extraction from dashboard click-through)
  const [stage, setStage] = useState(searchParams.get('stage') ?? FILTER_ALL);
  const [status, setStatus] = useState(searchParams.get('status') ?? FILTER_ALL);
  const [type, setType] = useState(searchParams.get('type') ?? FILTER_ALL);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Update URL params when filters change
  const updateFilter = useCallback(
    (key: string, value: string, setter: (v: string) => void) => {
      setter(value);
      setOffset(0);
      setExpandedId(null);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === FILTER_ALL) {
            next.delete(key);
          } else {
            next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Build query params
  const queryParams = new URLSearchParams();
  if (stage !== FILTER_ALL) queryParams.set('stage', stage);
  if (status !== FILTER_ALL) queryParams.set('status', status);
  if (type !== FILTER_ALL) queryParams.set('type', type);
  queryParams.set('limit', String(ITEMS_PAGE_SIZE));
  queryParams.set('offset', String(offset));

  const { data, isLoading, isError, refetch } = usePowerQuery<ItemsResponse>({
    queryKey: ['pipeline-items', stage, status, type, offset],
    queryFn: ({ signal }) =>
      fetchJson<ItemsResponse>(`/pipeline/items?${queryParams.toString()}`, { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });

  // Sync filter state when URL params change (e.g., stage click from PipelineVisualization)
  useEffect(() => {
    const urlStage = searchParams.get('stage');
    const urlStatus = searchParams.get('status');
    const urlType = searchParams.get('type');
    if ((urlStage ?? FILTER_ALL) !== stage) setStage(urlStage ?? FILTER_ALL);
    if ((urlStatus ?? FILTER_ALL) !== status) setStatus(urlStatus ?? FILTER_ALL);
    if ((urlType ?? FILTER_ALL) !== type) setType(urlType ?? FILTER_ALL);
  }, [searchParams]); // React to URL param changes

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasPoisoned = items.some((i) => i.status === 'poisoned');

  return (
    <div className="space-y-3">
      {/* Filter bar + retry all */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          stage={stage}
          status={status}
          type={type}
          onStageChange={(v) => updateFilter('stage', v, setStage)}
          onStatusChange={(v) => updateFilter('status', v, setStatus)}
          onTypeChange={(v) => updateFilter('type', v, setType)}
        />
        {hasPoisoned && <RetryAllBanner onRetried={() => refetch()} />}
      </div>

      {/* Items list */}
      <div className="rounded-md border border-border">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading work items...
          </div>
        )}

        {isError && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Failed to load work items
          </div>
        )}

        {!isLoading && !isError && items.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No items match the current filters
          </div>
        )}

        {!isLoading && items.length > 0 && (
          <div>
            {items.map((item) => {
              const rowKey = `${item.id}-${item.item_type}-${item.stage}`;
              return (
                <ItemRow
                  key={rowKey}
                  item={item}
                  isExpanded={expandedId === rowKey}
                  onToggle={() =>
                    setExpandedId((prev) => (prev === rowKey ? null : rowKey))
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > ITEMS_PAGE_SIZE && (
        <Pagination
          total={total}
          offset={offset}
          pageSize={ITEMS_PAGE_SIZE}
          onPrevious={() => setOffset((prev) => Math.max(0, prev - ITEMS_PAGE_SIZE))}
          onNext={() => setOffset((prev) => prev + ITEMS_PAGE_SIZE)}
        />
      )}
    </div>
  );
}
