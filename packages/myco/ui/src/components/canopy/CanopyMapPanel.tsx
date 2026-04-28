import { useCallback, useState } from 'react';
import { AlertCircle, Map as MapIcon, RefreshCw, RotateCcw } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { MarkdownContent } from '../ui/markdown-content';
import { useCanopyMap, useRegenerateCanopyMap } from '../../hooks/use-canopy';
import { formatEpochAbsolute } from '../../lib/format';

/**
 * Canopy Map sub-panel — sibling of Canopy Entries inside the Cortex Canopy
 * tab. Surfaces the current map (markdown) read from `GET /canopy/map`, with
 * two distinct actions:
 *
 *   - **Refresh** — incremental update (`force_cold_start: false`). Default
 *     action when a map already exists.
 *   - **Rebuild** — full regeneration (`force_cold_start: true`). Discards
 *     the prior draft and re-renders from scratch.
 *
 * The daemon contract (`force_cold_start` boolean) is unchanged; the UI just
 * maps the user's button choice to the right value behind the scenes.
 */
export function CanopyMapPanel() {
  const mapQuery = useCanopyMap();
  const regenerate = useRegenerateCanopyMap();

  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<'refresh' | 'rebuild' | null>(null);

  const triggerRegenerate = useCallback((mode: 'refresh' | 'rebuild') => {
    setRegenerateError(null);
    setPendingMode(mode);
    regenerate.mutate(
      { force_cold_start: mode === 'rebuild' },
      {
        onSettled: () => setPendingMode(null),
        onError: (err) => {
          setRegenerateError(err instanceof Error ? err.message : 'Regenerate failed');
        },
      },
    );
  }, [regenerate]);

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
              The Canopy Map is a guided tour of your project's architecture.
            </p>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              The Myco agent regenerates it as the codebase shifts, so connected
              agents can pull a current overview before exploring with Glob or
              Grep. Use <strong>Rebuild</strong> to start over from scratch instead
              of refreshing the existing draft.
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

          {!isEmpty ? (
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => triggerRegenerate('refresh')}
                  disabled={isPending}
                  className="gap-2"
                  data-testid="canopy-map-refresh"
                >
                  <RefreshCw
                    className={pendingMode === 'refresh' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                  />
                  {pendingMode === 'refresh' ? 'Refreshing…' : 'Refresh'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => triggerRegenerate('rebuild')}
                  disabled={isPending}
                  className="gap-2"
                  data-testid="canopy-map-rebuild"
                >
                  <RotateCcw
                    className={pendingMode === 'rebuild' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                  />
                  {pendingMode === 'rebuild' ? 'Rebuilding…' : 'Rebuild'}
                </Button>
              </div>
              {regenerateError ? (
                <span className="font-sans text-xs text-tertiary" role="alert">
                  {regenerateError}
                </span>
              ) : null}
            </div>
          ) : null}
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
              Generate the first map to give connected agents a high-level tour
              of your codebase. Future runs refresh incrementally; use{' '}
              <strong>Rebuild</strong> to start over.
            </p>
            {/* Cold start ≡ refresh on the empty path — single button. */}
            <Button
              variant="default"
              size="sm"
              onClick={() => triggerRegenerate('rebuild')}
              disabled={isPending}
              className="gap-2 mt-1"
              data-testid="canopy-map-generate"
            >
              <RefreshCw className={isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {isPending ? 'Generating…' : 'Generate Map'}
            </Button>
            {regenerateError ? (
              <span className="font-sans text-xs text-tertiary" role="alert">
                {regenerateError}
              </span>
            ) : null}
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

// Old name kept as an alias so consumers migrate at their own pace. The
// Cortex page already imports CanopyMapPanel via the new export above.
export { CanopyMapPanel as ProjectMapPanel };
