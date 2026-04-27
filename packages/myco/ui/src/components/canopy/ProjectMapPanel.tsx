import { useCallback, useState } from 'react';
import { AlertCircle, Map as MapIcon, RefreshCw } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Switch } from '../ui/switch';
import { MarkdownContent } from '../ui/markdown-content';
import { useCanopyMap, useRegenerateCanopyMap } from '../../hooks/use-canopy';
import { formatEpochAbsolute } from '../../lib/format';

/**
 * "Project Map" sub-panel — sibling of Canopy Entries inside the Cortex tab.
 *
 * Surfaces the rendered project map (markdown) read from `GET /canopy/map`,
 * with a "Regenerate Map" action that POSTs to `/canopy/map/regenerate`.
 * The regenerate task runs asynchronously on the daemon; on mutation success
 * the hook invalidates the query so the panel refetches the freshly written
 * row.
 */
export function ProjectMapPanel() {
  const mapQuery = useCanopyMap();
  const regenerate = useRegenerateCanopyMap();

  const [forceColdStart, setForceColdStart] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  const handleRegenerate = useCallback(() => {
    setRegenerateError(null);
    regenerate.mutate(
      { force_cold_start: forceColdStart },
      {
        onError: (err) => {
          setRegenerateError(err instanceof Error ? err.message : 'Regenerate failed');
        },
      },
    );
  }, [forceColdStart, regenerate]);

  const isPending = regenerate.isPending;
  const map = mapQuery.data;
  const isEmpty = map?.is_empty === true || !map?.content;
  const generatedLabel
    = map?.generated_at !== undefined && map.generated_at !== null
      ? formatEpochAbsolute(map.generated_at)
      : '—';
  const tokensLabel
    = map?.token_estimate !== undefined && map.token_estimate !== null
      ? map.token_estimate.toLocaleString()
      : '—';

  return (
    <div className="space-y-6" data-testid="project-map-panel">
      {/* Hero strip: explain the panel */}
      <Surface level="low" className="rounded-lg border border-primary/15 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <MapIcon className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <p className="font-sans text-sm font-medium text-on-surface">
              The narrative map agents read on demand via canopy_map().
            </p>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              A LLM-rendered tour of the codebase, regenerated on demand from the
              canopy index. Use "Force cold start" to discard the prior draft and
              re-render from scratch instead of an incremental update.
            </p>
          </div>
        </div>
      </Surface>

      {/* Header strip + action row */}
      <Surface level="low" className="rounded-lg border border-outline-variant/20 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2 min-w-0">
            <SectionHeader>Canopy Map</SectionHeader>
            <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
              <span data-testid="project-map-generated-at">
                Last generated: <span className="font-mono text-on-surface">{generatedLabel}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span data-testid="project-map-tokens">
                Tokens: <span className="font-mono text-on-surface">{tokensLabel}</span>
              </span>
              {isEmpty ? (
                <Badge variant="secondary" className="ml-1">No map yet</Badge>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-on-surface-variant select-none">
                <Switch
                  checked={forceColdStart}
                  onCheckedChange={setForceColdStart}
                  disabled={isPending}
                />
                <span>Force cold start</span>
              </label>
              <Button
                variant={isEmpty ? 'default' : 'outline'}
                size="sm"
                onClick={handleRegenerate}
                disabled={isPending}
                className="gap-2"
                data-testid="project-map-regenerate"
              >
                <RefreshCw
                  className={isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                />
                {isPending ? 'Generating…' : 'Regenerate Map'}
              </Button>
            </div>
            {regenerateError ? (
              <span className="font-sans text-xs text-tertiary" role="alert">
                {regenerateError}
              </span>
            ) : null}
          </div>
        </div>
      </Surface>

      {/* Body */}
      {mapQuery.isPending ? (
        <Surface level="low" className="rounded-lg border border-outline-variant/20 p-6">
          <div className="space-y-2" aria-busy="true">
            <div className="h-5 w-1/3 animate-pulse rounded bg-surface-container-high" />
            <div className="h-4 w-full animate-pulse rounded bg-surface-container-high" />
            <div className="h-4 w-5/6 animate-pulse rounded bg-surface-container-high" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-container-high" />
          </div>
        </Surface>
      ) : mapQuery.isError ? (
        <Surface level="low" className="rounded-lg border border-tertiary/20 p-6">
          <div
            className="flex flex-col items-center justify-center gap-2 text-tertiary"
            data-testid="project-map-error"
          >
            <AlertCircle className="h-5 w-5" />
            <span className="font-sans text-sm">Failed to load Canopy Map.</span>
            <span className="font-sans text-xs text-on-surface-variant">
              {mapQuery.error instanceof Error ? mapQuery.error.message : 'Unknown error'}
            </span>
          </div>
        </Surface>
      ) : isEmpty ? (
        <Surface level="low" className="rounded-lg border border-primary/20 p-8">
          <div
            className="flex flex-col items-center justify-center gap-3 text-center"
            data-testid="project-map-empty"
          >
            <MapIcon className="h-6 w-6 text-primary" />
            <p className="font-sans text-sm text-on-surface">
              {map?.message ?? 'No Canopy Map yet.'}
            </p>
            <p className="max-w-md font-sans text-xs text-on-surface-variant">
              Generate the first map to give agents a high-level tour of the
              codebase. Subsequent runs update incrementally unless "Force cold
              start" is checked.
            </p>
            <Button
              variant="default"
              size="sm"
              onClick={handleRegenerate}
              disabled={isPending}
              className="gap-2 mt-1"
              data-testid="project-map-regenerate-empty"
            >
              <RefreshCw className={isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {isPending ? 'Generating…' : 'Regenerate Map'}
            </Button>
          </div>
        </Surface>
      ) : (
        <Surface level="low" className="rounded-lg border border-outline-variant/20 p-6">
          <div data-testid="project-map-content">
            <MarkdownContent content={map.content} />
          </div>
        </Surface>
      )}
    </div>
  );
}
