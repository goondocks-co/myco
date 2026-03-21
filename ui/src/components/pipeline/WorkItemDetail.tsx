import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  Loader2,
  RotateCcw,
  ShieldBan,
  Timer,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson, postJson } from '../../lib/api';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const DETAIL_STALE_TIME = 15_000;

const STAGE_ORDER = ['capture', 'extraction', 'embedding', 'consolidation', 'digest'] as const;

const STATUS_ICON: Record<string, typeof CircleCheck> = {
  succeeded: CircleCheck,
  pending: Clock,
  processing: Loader2,
  failed: CircleX,
  blocked: ShieldBan,
  poisoned: ShieldBan,
};

const STATUS_COLOR: Record<string, string> = {
  succeeded: 'text-emerald-500',
  pending: 'text-muted-foreground',
  processing: 'text-amber-500',
  failed: 'text-red-500',
  blocked: 'text-red-400',
  poisoned: 'text-red-600',
};

const TIMELINE_LINE_COLOR: Record<string, string> = {
  succeeded: 'bg-emerald-500',
  pending: 'bg-muted-foreground/30',
  processing: 'bg-amber-400',
  failed: 'bg-red-500',
  blocked: 'bg-red-400',
  poisoned: 'bg-red-600',
};

/* ---------- Types ---------- */

interface StageStatus {
  stage: string;
  status: string;
  attempt: number;
  error_type: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface TransitionRecord {
  id: number;
  work_item_id: string;
  item_type: string;
  stage: string;
  status: string;
  attempt: number;
  error_type: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface ItemDetailResponse {
  id: string;
  type: string;
  stages: StageStatus[];
  history: TransitionRecord[];
}

/* ---------- Helpers ---------- */

function formatTimestamp(ts: string | null): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return ts;
  }
}

function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/* ---------- Stage Timeline Node ---------- */

function TimelineNode({
  stageStatus,
  isLast,
  itemId,
  itemType,
  onRetried,
}: {
  stageStatus: StageStatus;
  isLast: boolean;
  itemId: string;
  itemType: string;
  onRetried: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const Icon = STATUS_ICON[stageStatus.status] ?? CircleDot;
  const iconColor = STATUS_COLOR[stageStatus.status] ?? 'text-muted-foreground';
  const lineColor = TIMELINE_LINE_COLOR[stageStatus.status] ?? 'bg-muted-foreground/30';
  const isPoisoned = stageStatus.status === 'poisoned';

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await postJson(`/pipeline/retry/${encodeURIComponent(itemId)}`, {
        type: itemType,
        stage: stageStatus.stage,
      });
      onRetried();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex gap-3">
      {/* Timeline column */}
      <div className="flex flex-col items-center">
        <Icon
          className={cn(
            'h-5 w-5 shrink-0',
            iconColor,
            stageStatus.status === 'processing' && 'animate-spin',
          )}
        />
        {!isLast && <div className={cn('mt-1 w-0.5 flex-1 min-h-[24px]', lineColor)} />}
      </div>

      {/* Content */}
      <div className="flex-1 pb-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{stageLabel(stageStatus.stage)}</span>
          <Badge
            variant={stageStatus.status === 'succeeded' ? 'default' : stageStatus.status === 'pending' ? 'secondary' : 'destructive'}
            className="text-xs"
          >
            {stageStatus.status}
          </Badge>
          {stageStatus.attempt > 1 && (
            <span className="text-xs text-muted-foreground font-mono">
              attempt {stageStatus.attempt}
            </span>
          )}
          {isPoisoned && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 gap-1 text-xs"
              disabled={retrying}
              onClick={handleRetry}
            >
              {retrying ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              Retry
            </Button>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {stageStatus.started_at && (
            <span className="flex items-center gap-1">
              <Timer className="h-3 w-3" />
              {formatTimestamp(stageStatus.started_at)}
            </span>
          )}
          {stageStatus.completed_at && (
            <span>
              completed {formatTimestamp(stageStatus.completed_at)}
            </span>
          )}
        </div>

        {/* Error details */}
        {stageStatus.error_message && (
          <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
            {stageStatus.error_type && (
              <span className="font-medium text-destructive">[{stageStatus.error_type}]</span>
            )}{' '}
            <span className="text-destructive/80">{stageStatus.error_message}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Transition History ---------- */

function TransitionHistory({ history }: { history: TransitionRecord[] }) {
  const [expanded, setExpanded] = useState(false);

  if (history.length === 0) return null;

  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {history.length} transition{history.length !== 1 ? 's' : ''}
      </button>

      {expanded && (
        <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
          {history.map((t) => (
            <div
              key={t.id}
              className="flex items-start gap-3 rounded-md bg-muted/30 px-3 py-1.5 text-xs"
            >
              <span className="shrink-0 font-mono text-muted-foreground">#{t.id}</span>
              <span className="font-medium">{stageLabel(t.stage)}</span>
              <Badge
                variant={
                  t.status === 'succeeded'
                    ? 'default'
                    : t.status === 'pending'
                      ? 'secondary'
                      : 'destructive'
                }
                className="text-[10px] px-1.5 py-0"
              >
                {t.status}
              </Badge>
              {t.attempt > 1 && <span className="font-mono text-muted-foreground">att.{t.attempt}</span>}
              <span className="ml-auto shrink-0 text-muted-foreground">
                {formatTimestamp(t.created_at)}
              </span>
              {t.error_message && (
                <span className="basis-full mt-0.5 text-destructive/70 break-all">
                  {t.error_message}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Main Component ---------- */

export function WorkItemDetail({
  itemId,
  itemType,
}: {
  itemId: string;
  itemType: string;
}) {
  const { data, isLoading, isError, refetch } = useQuery<ItemDetailResponse>({
    queryKey: ['pipeline-item-detail', itemId, itemType],
    queryFn: ({ signal }) =>
      fetchJson<ItemDetailResponse>(
        `/pipeline/items/${encodeURIComponent(itemId)}?type=${encodeURIComponent(itemType)}`,
        { signal },
      ),
    staleTime: DETAIL_STALE_TIME,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 px-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading item details...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="py-4 px-4 text-sm text-muted-foreground">
        Failed to load item details
      </div>
    );
  }

  // Build a map of stages from the response for timeline ordering
  const stageMap = new Map(data.stages.map((s) => [s.stage, s]));

  // Order stages per pipeline order, filtering only those present
  const orderedStages = STAGE_ORDER.filter((s) => stageMap.has(s)).map((s) => stageMap.get(s)!);

  return (
    <div className="space-y-3 rounded-md border border-border bg-card/50 px-4 py-3">
      {/* Metadata */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">ID:</span>{' '}
          <span className="font-mono">{data.id}</span>
        </span>
        <span>
          <span className="font-medium text-foreground">Type:</span>{' '}
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{data.type}</Badge>
        </span>
      </div>

      {/* Stage timeline */}
      <div className="mt-3">
        {orderedStages.map((stage, idx) => (
          <TimelineNode
            key={stage.stage}
            stageStatus={stage}
            isLast={idx === orderedStages.length - 1}
            itemId={data.id}
            itemType={data.type}
            onRetried={() => refetch()}
          />
        ))}
      </div>

      {/* Transition history */}
      <TransitionHistory history={data.history} />
    </div>
  );
}
