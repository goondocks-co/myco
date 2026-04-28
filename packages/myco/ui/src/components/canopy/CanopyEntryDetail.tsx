import { useCallback, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Copy, RefreshCw, Sparkles, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import {
  useCanopyEntry,
  useReembedCanopyEntry,
  useRedescribeCanopyEntry,
  type CanopyEntryRow,
} from '../../hooks/use-canopy';
import { formatEpochAbsolute } from '../../lib/format';
import { parseJsonStringArray } from '@myco/utils/parse-json-array.js';

/* ---------- Helpers ---------- */

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/* ---------- Sub-components ---------- */

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 items-baseline">
      <span className="font-sans text-xs uppercase tracking-wide text-on-surface-variant">
        {label}
      </span>
      <div className="font-mono text-xs text-on-surface min-w-0 break-all">{children}</div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void onCopy()}
      className="gap-1 px-2 h-6 text-xs text-on-surface-variant"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          Copied
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          Copy
        </>
      )}
    </Button>
  );
}

function SkeletonDetail() {
  return (
    <div className="space-y-4">
      <div className="h-7 w-48 animate-pulse rounded bg-surface-container-high" />
      <div className="h-20 animate-pulse rounded-md bg-surface-container-high" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-4 w-full animate-pulse rounded bg-surface-container-high" />
        ))}
      </div>
    </div>
  );
}

/**
 * Outer slide-out chrome shared by every render branch (loading, error,
 * empty, and populated). Mirrors the Mycelium Inspector: glass Surface,
 * absolute right-edge positioning, scrollable body, optional X close.
 */
function DetailShell({
  onClose,
  children,
}: {
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Surface
      glass
      className="fixed top-3 right-3 bottom-3 z-30 w-[480px] max-w-[calc(100vw-1.5rem)] flex flex-col shadow-lg border border-outline-variant/15 rounded-md"
      data-testid="canopy-entry-detail-panel"
    >
      {onClose ? (
        <div className="flex justify-end px-3 pt-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail"
            data-testid="canopy-entry-detail-close"
            className="shrink-0 rounded-md p-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto px-5 pb-5 pt-2">{children}</div>
    </Surface>
  );
}

/* ---------- Component ---------- */

export interface CanopyEntryDetailProps {
  path: string;
  /** Legacy back button — retained for callers that still use stacked layout. */
  onBack?: () => void;
  /** Slide-out close handler — renders an X button in the top-right. */
  onClose?: () => void;
}

export function CanopyEntryDetail({ path, onBack, onClose }: CanopyEntryDetailProps) {
  const { data: entry, isPending, isError, error } = useCanopyEntry(path);
  const reembed = useReembedCanopyEntry();
  const redescribe = useRedescribeCanopyEntry();

  const [reembedError, setReembedError] = useState<string | null>(null);
  const [reembedSuccess, setReembedSuccess] = useState(false);
  const [redescribeError, setRedescribeError] = useState<string | null>(null);
  const [redescribeSuccess, setRedescribeSuccess] = useState(false);

  const exportsList = useMemo(
    () => parseJsonStringArray(entry?.exports_json ?? null),
    [entry?.exports_json],
  );
  const importsList = useMemo(
    () => parseJsonStringArray(entry?.imports_json ?? null),
    [entry?.imports_json],
  );

  const handleReembed = useCallback(() => {
    setReembedError(null);
    setReembedSuccess(false);
    reembed.mutate(path, {
      onSuccess: () => {
        setReembedSuccess(true);
        window.setTimeout(() => setReembedSuccess(false), 2500);
      },
      onError: (err) => {
        setReembedError(err instanceof Error ? err.message : 'Re-embed failed');
      },
    });
  }, [path, reembed]);

  const handleRedescribe = useCallback(() => {
    setRedescribeError(null);
    setRedescribeSuccess(false);
    redescribe.mutate(path, {
      onSuccess: () => {
        setRedescribeSuccess(true);
        window.setTimeout(() => setRedescribeSuccess(false), 2500);
      },
      onError: (err) => {
        setRedescribeError(err instanceof Error ? err.message : 'Re-describe failed');
      },
    });
  }, [path, redescribe]);

  if (isPending) {
    return (
      <DetailShell onClose={onClose}>
        <SkeletonDetail />
      </DetailShell>
    );
  }

  if (isError) {
    return (
      <DetailShell onClose={onClose}>
        <div className="space-y-3">
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
              <ArrowLeft className="h-4 w-4" />
              Back to list
            </Button>
          ) : null}
          <div
            className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary"
            data-testid="canopy-entry-detail-error"
          >
            <AlertCircle className="h-5 w-5" />
            <span className="font-sans text-sm">Failed to load entry</span>
            <span className="font-sans text-xs text-on-surface-variant">
              {error instanceof Error ? error.message : 'Unknown error'}
            </span>
          </div>
        </div>
      </DetailShell>
    );
  }

  if (!entry) {
    return (
      <DetailShell onClose={onClose}>
        <div className="space-y-3">
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
              <ArrowLeft className="h-4 w-4" />
              Back to list
            </Button>
          ) : null}
          <div
            className="flex h-40 flex-col items-center justify-center gap-2 text-on-surface-variant"
            data-testid="canopy-entry-detail-empty"
          >
            <AlertCircle className="h-5 w-5 opacity-50" />
            <span className="font-sans text-sm">No entry found at this path.</span>
          </div>
        </div>
      </DetailShell>
    );
  }

  const isEmbedded = entry.embedded === 1;

  return (
    <DetailShell onClose={onClose}>
      <div className="space-y-4" data-testid="canopy-entry-detail">
        {/* Header / actions */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2 min-w-0">
            {onBack ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="gap-2 text-on-surface-variant -ml-2"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to list
              </Button>
            ) : null}
            <h2 className="font-mono text-sm text-on-surface break-all" title={entry.path}>
              {entry.path}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {entry.language ? (
                <Badge variant="outline">{entry.language}</Badge>
              ) : null}
              <Badge variant={isEmbedded ? 'default' : 'secondary'}>
                {isEmbedded ? 'Embedded' : 'Not embedded'}
              </Badge>
              <Badge variant={entry.llm_description ? 'default' : 'secondary'}>
                {entry.llm_description ? 'Described' : 'No description'}
              </Badge>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRedescribe}
                disabled={redescribe.isPending}
                className="gap-2"
                data-testid="canopy-entry-redescribe"
                aria-label="Re-run the Myco agent's description for this file."
                title="Re-run the Myco agent's description for this file."
              >
                <Sparkles className={redescribe.isPending ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} />
                {redescribe.isPending ? 'Describing...' : 'Re-describe'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReembed}
                disabled={reembed.isPending}
                className="gap-2"
                data-testid="canopy-entry-reembed"
              >
                <RefreshCw className={reembed.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                {reembed.isPending ? 'Queuing...' : 'Re-embed'}
              </Button>
            </div>
            {redescribeSuccess ? (
              <span className="font-sans text-xs text-primary" role="status">
                Queued for re-describe
              </span>
            ) : null}
            {redescribeError ? (
              <span className="font-sans text-xs text-tertiary" role="alert">
                {redescribeError}
              </span>
            ) : null}
            {reembedSuccess ? (
              <span className="font-sans text-xs text-primary" role="status">
                Queued for re-embed
              </span>
            ) : null}
            {reembedError ? (
              <span className="font-sans text-xs text-tertiary" role="alert">
                {reembedError}
              </span>
            ) : null}
          </div>
        </div>

        {/* Description callout */}
        {entry.llm_description ? (
          <Surface level="low" className="rounded-md border border-primary/15 p-4">
            <SectionHeader>Description</SectionHeader>
            <p className="mt-2 font-sans text-sm text-on-surface leading-relaxed">
              {entry.llm_description}
            </p>
          </Surface>
        ) : (
          <Surface level="low" className="rounded-md border border-outline-variant/20 p-4">
            <SectionHeader>Description</SectionHeader>
            <p className="mt-2 font-sans text-sm text-on-surface-variant">
              The Myco agent hasn't described this file yet.
            </p>
          </Surface>
        )}

        {/* Exports / Imports */}
        <div className="grid gap-3 lg:grid-cols-2">
          <Surface level="low" className="rounded-md border border-outline-variant/20 p-4 space-y-2">
            <SectionHeader>Exports</SectionHeader>
            {exportsList.length === 0 ? (
              <p className="font-sans text-xs text-on-surface-variant">No exports detected.</p>
            ) : (
              <ul className="space-y-1">
                {exportsList.map((sym) => (
                  <li key={sym} className="font-mono text-xs text-on-surface break-all">
                    {sym}
                  </li>
                ))}
              </ul>
            )}
          </Surface>

          <Surface level="low" className="rounded-md border border-outline-variant/20 p-4 space-y-2">
            <SectionHeader>Imports</SectionHeader>
            {importsList.length === 0 ? (
              <p className="font-sans text-xs text-on-surface-variant">No imports detected.</p>
            ) : (
              <ul className="space-y-1">
                {importsList.map((mod) => (
                  <li key={mod} className="font-mono text-xs text-on-surface break-all">
                    {mod}
                  </li>
                ))}
              </ul>
            )}
          </Surface>
        </div>

        {/* Top comment */}
        {entry.top_comment ? (
          <Surface level="low" className="rounded-md border border-outline-variant/20 p-4 space-y-2">
            <SectionHeader>Top Comment</SectionHeader>
            <pre className="whitespace-pre-wrap font-mono text-xs text-on-surface">{entry.top_comment}</pre>
          </Surface>
        ) : null}

        {/* Metadata grid */}
        <Surface level="low" className="rounded-md border border-outline-variant/20 p-4 space-y-3">
          <SectionHeader>Metadata</SectionHeader>
          <div className="space-y-2">
            <FieldRow label="Tokens">{entry.token_estimate.toLocaleString()}</FieldRow>
            <FieldRow label="Lines">{entry.line_count.toLocaleString()}</FieldRow>
            <FieldRow label="Size">{entry.size_bytes.toLocaleString()} B</FieldRow>
            <FieldRow label="Hash">
              <span className="inline-flex items-center gap-2">
                <code title={entry.content_hash}>{shortHash(entry.content_hash)}</code>
                <CopyButton text={entry.content_hash} />
              </span>
            </FieldRow>
            <FieldRow label="Indexed">
              {formatEpochAbsolute(entry.mechanical_updated_at)}
            </FieldRow>
            <FieldRow label="Described">
              {entry.llm_updated_at !== null
                ? formatEpochAbsolute(entry.llm_updated_at)
                : '—'}
            </FieldRow>
          </div>
        </Surface>
      </div>
    </DetailShell>
  );
}

export type { CanopyEntryRow };
