import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, AlertTriangle } from 'lucide-react';
import { fetchJson } from '../../lib/api';
import { OperationButton } from './OperationButton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Badge } from '../ui/badge';

const SESSIONS_STALE_TIME = 30_000;
const ALL_DATES = '__all__';
const MODE_ALL = 'all';
const MODE_DATE = 'date';
const MODE_FAILED = 'failed';
const MODE_INDEX_ONLY = 'index-only';

interface SessionInfo {
  id: string;
  date: string;
  title: string;
  hasFailed: boolean;
}

interface SessionsResponse {
  sessions: SessionInfo[];
  dates: string[];
}

type ReprocessMode = typeof MODE_ALL | typeof MODE_DATE | typeof MODE_FAILED | typeof MODE_INDEX_ONLY;

export function ReprocessPanel() {
  const [mode, setMode] = useState<ReprocessMode>(MODE_ALL);
  const [selectedDate, setSelectedDate] = useState(ALL_DATES);

  const { data } = useQuery<SessionsResponse>({
    queryKey: ['sessions'],
    queryFn: ({ signal }) => fetchJson<SessionsResponse>('/sessions', { signal }),
    staleTime: SESSIONS_STALE_TIME,
  });

  const dates = data?.dates ?? [];
  const sessions = data?.sessions ?? [];
  const failedCount = sessions.filter((s) => s.hasFailed).length;

  const body = useMemo(() => {
    switch (mode) {
      case MODE_DATE:
        return selectedDate !== ALL_DATES ? { date: selectedDate } : {};
      case MODE_FAILED:
        return { failed: true };
      case MODE_INDEX_ONLY:
        return { index_only: true };
      default:
        return {};
    }
  }, [mode, selectedDate]);

  const sessionCount = useMemo(() => {
    if (mode === MODE_DATE && selectedDate !== ALL_DATES) {
      return sessions.filter((s) => s.date === selectedDate).length;
    }
    if (mode === MODE_FAILED) return failedCount;
    return sessions.length;
  }, [mode, selectedDate, sessions, failedCount]);

  const modeLabel = useMemo(() => {
    switch (mode) {
      case MODE_DATE:
        return selectedDate !== ALL_DATES
          ? `Reprocess ${selectedDate}`
          : 'Reprocess All';
      case MODE_FAILED:
        return `Reprocess ${failedCount} Failed`;
      case MODE_INDEX_ONLY:
        return 'Re-index Only (no LLM)';
      default:
        return 'Reprocess All';
    }
  }, [mode, selectedDate, failedCount]);

  return (
    <div className="space-y-4">
      {/* Mode selector */}
      <div className="flex flex-wrap items-center gap-2">
        {([
          [MODE_ALL, 'All Sessions'],
          [MODE_DATE, 'By Date'],
          [MODE_FAILED, 'Failed Only'],
          [MODE_INDEX_ONLY, 'Index Only'],
        ] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-md border px-3 py-1 text-xs transition-colors ${
              mode === m
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Date picker */}
      {mode === MODE_DATE && dates.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Date:</span>
          <Select value={selectedDate} onValueChange={setSelectedDate}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_DATES}>All dates</SelectItem>
              {dates.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <OperationButton
        label={modeLabel}
        endpoint="/reprocess"
        body={body}
        icon={<Clock className="h-4 w-4" />}
        description={`Re-extract observations and regenerate summaries for ${sessionCount} session(s).`}
      />

      {/* Stats */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Sessions:</span>
          <Badge variant="secondary" className="font-mono text-xs">
            {sessions.length}
          </Badge>
        </div>
        {failedCount > 0 && (
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
            <span className="text-muted-foreground">Failed:</span>
            <Badge variant="secondary" className="font-mono text-xs text-yellow-600 dark:text-yellow-400">
              {failedCount}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}
