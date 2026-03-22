import { useQuery } from '@tanstack/react-query';
import { Activity, Clock, Gauge, Loader2, Zap } from 'lucide-react';
import { fetchJson, postJson } from '../../lib/api';
import { formatTimeAgo } from '../../lib/format';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { useState } from 'react';

const DIGEST_HEALTH_POLL_INTERVAL = 15_000;
const DIGEST_TIERS = [1500, 3000, 5000, 7500, 10000] as const;

interface DigestHealthResponse {
  last_cycle: {
    cycle_id: string;
    timestamp: string;
    substrate_count: number;
    tiers_generated: number[];
    duration_ms: number;
    model: string;
  } | null;
  substrate_ready: number;
  substrate_threshold: number;
  metabolism_state: string;
  digest_ready: boolean;
  cycle_in_progress: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function DigestHealthPanel() {
  const [forcing, setForcing] = useState(false);
  const [mode, setMode] = useState<'force' | 'tier'>('force');
  const [selectedTier, setSelectedTier] = useState('3000');

  const { data, isLoading } = useQuery<DigestHealthResponse>({
    queryKey: ['digest-health'],
    queryFn: ({ signal }) =>
      fetchJson<DigestHealthResponse>('/pipeline/digest-health', { signal }),
    refetchInterval: DIGEST_HEALTH_POLL_INTERVAL,
  });

  if (isLoading || !data) return null;

  const progress = data.substrate_threshold > 0
    ? Math.min(100, Math.round((data.substrate_ready / data.substrate_threshold) * 100))
    : 100;
  const remaining = Math.max(0, data.substrate_threshold - data.substrate_ready);

  const handleDigest = async () => {
    setForcing(true);
    try {
      if (mode === 'tier') {
        await postJson('/digest', { tier: Number(selectedTier) });
      } else {
        await postJson('/pipeline/digest/force', {});
      }
    } finally {
      setForcing(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Active cycle indicator */}
      {data.cycle_in_progress && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="font-medium">Digest cycle in progress</span>
        </div>
      )}

      {/* Substrate + status row */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {/* Substrate progress */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="h-2 flex-1 min-w-[80px] rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {data.substrate_ready}/{data.substrate_threshold}
          </span>
        </div>

        {/* Status badges */}
        <div className="flex items-center gap-2">
          <Badge
            variant={data.metabolism_state === 'active' ? 'default' : 'secondary'}
            className="text-xs"
          >
            <Activity className="mr-1 h-3 w-3" />
            {data.metabolism_state}
          </Badge>
          {data.digest_ready && (
            <Badge variant="default" className="text-xs">
              <Zap className="mr-1 h-3 w-3" />
              Ready
            </Badge>
          )}
        </div>
      </div>

      {/* Digest controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={mode === 'force' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('force')}
        >
          Full Cycle
        </Button>
        <Button
          variant={mode === 'tier' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('tier')}
        >
          Single Tier
        </Button>

        {mode === 'tier' && (
          <Select value={selectedTier} onValueChange={setSelectedTier}>
            <SelectTrigger className="h-8 w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIGEST_TIERS.map((tier) => (
                <SelectItem key={tier} value={String(tier)}>
                  T{tier}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          variant="outline"
          size="sm"
          disabled={forcing}
          onClick={handleDigest}
        >
          {forcing ? 'Running...' : mode === 'tier' ? `Run T${selectedTier}` : 'Force Digest'}
        </Button>
      </div>

      {/* Last cycle */}
      {data.last_cycle && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>
            <span className="text-foreground">{formatTimeAgo(data.last_cycle.timestamp)}</span>
          </span>
          <span>{data.last_cycle.substrate_count} notes</span>
          <span>{formatDuration(data.last_cycle.duration_ms)}</span>
          <span>T[{data.last_cycle.tiers_generated.join(', ')}]</span>
          <span className="truncate">{data.last_cycle.model}</span>
        </div>
      )}
    </div>
  );
}
