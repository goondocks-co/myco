/**
 * Release-provenance UI primitives.
 *
 * `ReleaseStateBadge` renders the full chip ("released · high") for header
 * rows where there's room for the label.
 *
 * `ReleaseStateDot` is the compact 10px indicator used in dense list rows:
 * inner color encodes the state, ring style encodes the confidence:
 *   - high   → solid fill
 *   - medium → 50% fill + ring
 *   - low    → ring only
 * Hover surfaces the compact summary via `title`; session list/detail callers
 * can also pass a namespace + recordId to open structured provenance details.
 */

import { useState, type JSX, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { ReleaseProvenanceDialog } from './ReleaseProvenanceDialog';

export interface ReleaseStateAnnotation {
  state: string;
  confidence?: string | null;
  basis_kind?: string | null;
  basis_ref?: string | null;
  checked_at?: number;
  reason?: string | null;
}

const STATE_LABEL: Record<string, string> = {
  released: 'released',
  merged_unreleased: 'merged',
  not_on_release_line: 'feature',
  unknown: 'unknown',
  unreconciled: 'unreconciled',
};

const STATE_BADGE_CLASS: Record<string, string> = {
  released: 'bg-primary/15 text-primary',
  merged_unreleased: 'bg-secondary/15 text-secondary',
  not_on_release_line: 'border border-[var(--ghost-border)] text-on-surface-variant',
  unknown: 'bg-surface-container-high text-on-surface-variant',
  unreconciled: 'border border-[var(--ghost-border)] text-on-surface-variant/70',
};
const UNKNOWN_STATE_BADGE_CLASS = STATE_BADGE_CLASS.unknown ?? 'bg-surface-container-high text-on-surface-variant';

/**
 * Theme-aware base colors for the state. Used by both the badge and the
 * confidence-encoded dot so the two stay visually linked. Tailwind needs the
 * full class strings to live in source for its JIT scanner.
 */
const STATE_DOT_FILL: Record<string, string> = {
  released: 'bg-primary',
  merged_unreleased: 'bg-secondary',
  not_on_release_line: 'bg-on-surface-variant/50',
  unknown: 'bg-on-surface-variant/40',
  unreconciled: 'bg-on-surface-variant/25',
};
const UNKNOWN_STATE_DOT_FILL = STATE_DOT_FILL.unknown ?? 'bg-on-surface-variant/40';

const STATE_DOT_RING: Record<string, string> = {
  released: 'border-primary',
  merged_unreleased: 'border-secondary',
  not_on_release_line: 'border-on-surface-variant/50',
  unknown: 'border-on-surface-variant/40',
  unreconciled: 'border-on-surface-variant/25',
};
const UNKNOWN_STATE_DOT_RING = STATE_DOT_RING.unknown ?? 'border-on-surface-variant/40';

function buildTitle(annotation: ReleaseStateAnnotation): string {
  const parts: string[] = [STATE_LABEL[annotation.state] ?? annotation.state];
  if (annotation.confidence) parts.push(`confidence: ${annotation.confidence}`);
  if (annotation.basis_kind) parts.push(`basis: ${annotation.basis_kind}`);
  if (annotation.basis_ref) parts.push(`ref: ${annotation.basis_ref}`);
  if (annotation.reason) parts.push(annotation.reason);
  return parts.join(' — ');
}

export interface ReleaseStateBadgeProps {
  annotation: ReleaseStateAnnotation | null | undefined;
  className?: string;
  namespace?: string;
  recordId?: string;
}

export function ReleaseStateBadge({
  annotation,
  className,
  namespace,
  recordId,
}: ReleaseStateBadgeProps): JSX.Element | null {
  if (!annotation) return null;
  const label = STATE_LABEL[annotation.state] ?? annotation.state;
  const stateClass = STATE_BADGE_CLASS[annotation.state] ?? UNKNOWN_STATE_BADGE_CLASS;
  const title = buildTitle(annotation);
  const canOpenDetail = Boolean(namespace && recordId);

  return (
    <ReleaseStateTrigger
      annotation={annotation}
      namespace={namespace}
      recordId={recordId}
      title={title}
      canOpenDetail={canOpenDetail}
      className={cn(
        'inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 font-sans text-[10px] font-medium uppercase tracking-wider',
        canOpenDetail && 'cursor-pointer hover:ring-1 hover:ring-current/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-current/40',
        stateClass,
        className,
      )}
    >
      <span>{label}</span>
      {annotation.confidence ? (
        <span className="font-mono normal-case opacity-70">{annotation.confidence}</span>
      ) : null}
    </ReleaseStateTrigger>
  );
}

export interface ReleaseStateDotProps {
  annotation: ReleaseStateAnnotation | null | undefined;
  className?: string;
  namespace?: string;
  recordId?: string;
}

/**
 * 10px circle where the inner color encodes the release state and the ring
 * encodes confidence (solid=high, half=medium, ring-only=low). When no
 * confidence is set (unknown/unreconciled rows), renders the faded state
 * fill without a ring so the dot still reads as "no signal yet."
 */
export function ReleaseStateDot({
  annotation,
  className,
  namespace,
  recordId,
}: ReleaseStateDotProps): JSX.Element | null {
  if (!annotation) return null;
  const fill = STATE_DOT_FILL[annotation.state] ?? UNKNOWN_STATE_DOT_FILL;
  const ring = STATE_DOT_RING[annotation.state] ?? UNKNOWN_STATE_DOT_RING;
  const confidence = annotation.confidence ?? null;

  let visual: string;
  if (confidence === 'high') {
    visual = fill;
  } else if (confidence === 'medium') {
    visual = cn(fill, 'opacity-60 border', ring);
  } else if (confidence === 'low') {
    visual = cn('bg-transparent border-2', ring);
  } else {
    visual = cn(fill, 'opacity-50');
  }

  const title = buildTitle(annotation);
  const canOpenDetail = Boolean(namespace && recordId);

  return (
    <ReleaseStateTrigger
      annotation={annotation}
      namespace={namespace}
      recordId={recordId}
      title={title}
      canOpenDetail={canOpenDetail}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
        canOpenDetail && 'cursor-pointer hover:bg-surface-container focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sage/40',
        className,
      )}
    >
      <span className={cn('inline-block h-2.5 w-2.5 rounded-full', visual)} aria-hidden />
    </ReleaseStateTrigger>
  );
}

interface ReleaseStateTriggerProps {
  annotation: ReleaseStateAnnotation;
  namespace?: string;
  recordId?: string;
  title: string;
  canOpenDetail: boolean;
  className?: string;
  children: ReactNode;
}

function ReleaseStateTrigger({
  annotation,
  namespace,
  recordId,
  title,
  canOpenDetail,
  className,
  children,
}: ReleaseStateTriggerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ariaLabel = `Release provenance: ${buildTitle(annotation)}`;

  if (!canOpenDetail || !namespace || !recordId) {
    return (
      <span className={className} title={title} aria-label={`Release: ${title}`} role="img">
        {children}
      </span>
    );
  }

  return (
    <>
      <span
        className={className}
        title={title}
        aria-label={ariaLabel}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </span>
      <ReleaseProvenanceDialog
        open={open}
        onOpenChange={setOpen}
        namespace={namespace}
        recordId={recordId}
      />
    </>
  );
}
