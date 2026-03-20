import { useState, useCallback, useEffect } from 'react';
import { Loader2, Eye, Play, CheckCircle2, XCircle } from 'lucide-react';
import { postJson } from '../../lib/api';
import { useProgress } from '../../hooks/use-progress';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';

/** Duration to show the execute result before clearing */
const EXECUTE_RESULT_DURATION_MS = 6_000;

interface DryRunResult {
  dry_run: true;
  scanned: number;
  clustersEvaluated: number;
  superseded: number;
}

type PreviewPhase = 'idle' | 'loading' | 'loaded' | 'error';
type ExecutePhase = 'idle' | 'submitting' | 'tracking' | 'complete' | 'failed';

export function CurationPanel() {
  // Preview state
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>('idle');
  const [previewResult, setPreviewResult] = useState<DryRunResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Execute state
  const [executePhase, setExecutePhase] = useState<ExecutePhase>('idle');
  const [executeToken, setExecuteToken] = useState<string | null>(null);
  const [executeMessage, setExecuteMessage] = useState<string | null>(null);

  const { data: progress } = useProgress(executeToken);

  // React to execution progress
  useEffect(() => {
    if (!progress) return;

    if (progress.status === 'completed') {
      setExecutePhase('complete');
      setExecuteMessage(progress.message ?? 'Curation complete');
      setExecuteToken(null);
      // Clear preview since spores have changed
      setPreviewResult(null);
      setPreviewPhase('idle');
    } else if (progress.status === 'failed') {
      setExecutePhase('failed');
      setExecuteMessage(progress.message ?? 'Curation failed');
      setExecuteToken(null);
    }
  }, [progress]);

  // Auto-reset execute result
  useEffect(() => {
    if (executePhase !== 'complete' && executePhase !== 'failed') return;
    const timer = setTimeout(() => {
      setExecutePhase('idle');
      setExecuteMessage(null);
    }, EXECUTE_RESULT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [executePhase]);

  const handlePreview = useCallback(async () => {
    setPreviewPhase('loading');
    setPreviewError(null);
    try {
      const result = await postJson<DryRunResult>('/curate', { dry_run: true });
      setPreviewResult(result);
      setPreviewPhase('loaded');
    } catch {
      setPreviewError('Failed to load curation preview');
      setPreviewPhase('error');
    }
  }, []);

  const handleExecute = useCallback(async () => {
    setExecutePhase('submitting');
    try {
      const res = await postJson<{ token?: string }>('/curate', { dry_run: false });
      if (res.token) {
        setExecuteToken(res.token);
        setExecutePhase('tracking');
      } else {
        setExecutePhase('complete');
        setExecuteMessage('Curation complete');
      }
    } catch {
      setExecutePhase('failed');
      setExecuteMessage('Curation request failed');
    }
  }, []);

  const isExecuting = executePhase === 'submitting' || executePhase === 'tracking';
  const progressPercent = executePhase === 'tracking' && progress?.percent != null ? progress.percent : null;

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={previewPhase === 'loading' || isExecuting}
          onClick={handlePreview}
        >
          {previewPhase === 'loading' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
          {previewPhase === 'loading' ? 'Scanning...' : 'Preview'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          className={cn(
            'gap-2 transition-colors',
            executePhase === 'complete' && 'border-primary/50 text-primary',
            executePhase === 'failed' && 'border-destructive/50 text-destructive',
          )}
          disabled={isExecuting || previewPhase === 'loading'}
          onClick={handleExecute}
        >
          {isExecuting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : executePhase === 'complete' ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : executePhase === 'failed' ? (
            <XCircle className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {isExecuting
            ? (progress?.message ?? 'Curating...')
            : executeMessage ?? 'Execute'}
        </Button>

        {progressPercent !== null && (
          <span className="text-xs font-mono text-muted-foreground">
            {Math.round(progressPercent)}%
          </span>
        )}
      </div>

      {/* Progress bar */}
      {isExecuting && progressPercent !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      {/* Preview error */}
      {previewPhase === 'error' && previewError && (
        <p className="text-sm text-destructive">{previewError}</p>
      )}

      {/* Preview results */}
      {previewPhase === 'loaded' && previewResult && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-background p-3 text-sm space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Spores scanned</span>
              <Badge variant="secondary" className="font-mono text-xs">{previewResult.scanned}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Clusters evaluated</span>
              <Badge variant="secondary" className="font-mono text-xs">{previewResult.clustersEvaluated}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Would supersede</span>
              <Badge
                variant={previewResult.superseded > 0 ? 'destructive' : 'secondary'}
                className="font-mono text-xs"
              >
                {previewResult.superseded}
              </Badge>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {previewResult.superseded === 0
              ? 'No duplicate spores found.'
              : `${previewResult.superseded} spore${previewResult.superseded === 1 ? '' : 's'} would be superseded. Run Execute to apply.`}
          </p>
        </div>
      )}
    </div>
  );
}
