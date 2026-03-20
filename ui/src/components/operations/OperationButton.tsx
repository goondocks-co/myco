import { useState, useCallback, useEffect } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { postJson } from '../../lib/api';
import { useProgress, type ProgressState } from '../../hooks/use-progress';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

/** Duration to show the result message before resetting to idle */
const RESULT_DISPLAY_DURATION_MS = 4_000;

interface OperationButtonProps {
  label: string;
  endpoint: string;
  body?: unknown;
  description?: string;
  icon?: React.ReactNode;
  onComplete?: (result: unknown) => void;
  disabled?: boolean;
}

type OperationPhase = 'idle' | 'submitting' | 'tracking' | 'complete' | 'failed';

export function OperationButton({
  label,
  endpoint,
  body,
  description,
  icon,
  onComplete,
  disabled,
}: OperationButtonProps) {
  const [phase, setPhase] = useState<OperationPhase>('idle');
  const [token, setToken] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const { data: progress } = useProgress(token);

  // React to progress updates
  useEffect(() => {
    if (!progress) return;

    if (progress.status === 'complete') {
      setPhase('complete');
      setResultMessage(progress.message ?? 'Done');
      setToken(null);
      onComplete?.(progress.result);
    } else if (progress.status === 'failed') {
      setPhase('failed');
      setResultMessage(progress.message ?? 'Failed');
      setToken(null);
    }
  }, [progress, onComplete]);

  // Auto-reset after displaying result
  useEffect(() => {
    if (phase !== 'complete' && phase !== 'failed') return;
    const timer = setTimeout(() => {
      setPhase('idle');
      setResultMessage(null);
    }, RESULT_DISPLAY_DURATION_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const handleClick = useCallback(async () => {
    setPhase('submitting');
    try {
      const res = await postJson<{ token?: string }>(endpoint, body);
      if (res.token) {
        setToken(res.token);
        setPhase('tracking');
      } else {
        // No token means immediate completion
        setPhase('complete');
        setResultMessage('Done');
        onComplete?.(res);
      }
    } catch {
      setPhase('failed');
      setResultMessage('Request failed');
    }
  }, [endpoint, body, onComplete]);

  const isRunning = phase === 'submitting' || phase === 'tracking';
  const progressPercent = phase === 'tracking' && progress?.percent != null ? progress.percent : null;
  const progressMessage = phase === 'tracking' ? progress?.message : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'gap-2 transition-colors',
            phase === 'complete' && 'border-primary/50 text-primary',
            phase === 'failed' && 'border-destructive/50 text-destructive',
          )}
          disabled={isRunning || disabled}
          onClick={handleClick}
        >
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : phase === 'complete' ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : phase === 'failed' ? (
            <XCircle className="h-4 w-4" />
          ) : (
            icon
          )}
          {isRunning ? (progressMessage ?? 'Running...') : resultMessage ?? label}
        </Button>

        {progressPercent !== null && (
          <span className="text-xs font-mono text-muted-foreground">
            {Math.round(progressPercent)}%
          </span>
        )}
      </div>

      {/* Progress bar */}
      {isRunning && progressPercent !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      {description && phase === 'idle' && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
