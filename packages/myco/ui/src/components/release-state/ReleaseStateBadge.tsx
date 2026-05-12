/**
 * Compact badge that renders a release-provenance annotation as a single
 * chip ("released · high", "unknown", "merged_unreleased · medium", ...).
 *
 * The annotation shape matches `ReleaseStateAnnotation` in
 * packages/myco/src/release-provenance/annotations.ts — the daemon
 * already attaches it to spores / sessions / plans / search results, so
 * UI rows can render it without any new API work.
 *
 * Variants by state:
 *   released           → primary (sage)     "this knowledge ships on a release ref"
 *   merged_unreleased  → warning (ochre)    "merged but not yet on a release ref"
 *   not_on_release_line → outline           "off the release line, treat as feature work"
 *   unknown            → secondary          "evidence missing or ambiguous"
 *   unreconciled       → outline            "config absent or reconciler hasn't run yet"
 */

import { cn } from '../../lib/cn';

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

const STATE_CLASS: Record<string, string> = {
  released: 'bg-primary/15 text-primary',
  merged_unreleased: 'bg-secondary/15 text-secondary',
  not_on_release_line: 'border border-[var(--ghost-border)] text-on-surface-variant',
  unknown: 'bg-surface-container-high text-on-surface-variant',
  unreconciled: 'border border-[var(--ghost-border)] text-on-surface-variant/70',
};

function buildTitle(annotation: ReleaseStateAnnotation): string {
  const parts: string[] = [annotation.state];
  if (annotation.confidence) parts.push(`confidence: ${annotation.confidence}`);
  if (annotation.basis_kind) parts.push(`basis: ${annotation.basis_kind}`);
  if (annotation.basis_ref) parts.push(`ref: ${annotation.basis_ref}`);
  if (annotation.reason) parts.push(annotation.reason);
  return parts.join(' — ');
}

export interface ReleaseStateBadgeProps {
  annotation: ReleaseStateAnnotation | null | undefined;
  className?: string;
}

export function ReleaseStateBadge({ annotation, className }: ReleaseStateBadgeProps): JSX.Element | null {
  if (!annotation) return null;
  const label = STATE_LABEL[annotation.state] ?? annotation.state;
  const stateClass = STATE_CLASS[annotation.state] ?? STATE_CLASS.unknown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 font-sans text-[10px] font-medium uppercase tracking-wider',
        stateClass,
        className,
      )}
      title={buildTitle(annotation)}
    >
      <span>{label}</span>
      {annotation.confidence ? (
        <span className="font-mono normal-case opacity-70">{annotation.confidence}</span>
      ) : null}
    </span>
  );
}
