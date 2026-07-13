/**
 * Shared shell for config field rows on the unified Settings page.
 * Renders the label + scope indicator + helper text + (any) input +
 * error in the same layout so every field stays visually aligned
 * without each call site rolling its own version.
 *
 * The shell handles layout only — state, commit logic, and tier
 * routing belong to the call site (ScopedField, NumberField, etc.).
 */

import { type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { ScopeBadge } from './ScopePill';

type FieldScope = 'personal' | 'project' | 'grove' | 'machine' | 'team';

export interface FieldShellProps {
  id?: string;
  label: string;
  /**
   * Default-state scope to badge next to the label. Pass `null` to
   * hide the badge entirely (e.g. read-only stats rows on System).
   */
  scope?: FieldScope | null;
  /**
   * Optional override slot for the scope position — used by
   * ScopedField to show a Personal pill (with promote/reset
   * affordances) instead of the static badge.
   */
  scopeIndicator?: ReactNode;
  /** Inline hint shown next to the label in parens. */
  hint?: string;
  /** Helper text shown below the input. */
  helper?: string;
  /** Save-failure message shown below the input. */
  error?: string;
  children: ReactNode;
}

export function FieldShell({
  id,
  label,
  scope,
  scopeIndicator,
  hint,
  helper,
  error,
  children,
}: FieldShellProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="font-sans text-sm font-medium text-on-surface">
          {label}
        </label>
        {hint && (
          <span className="font-sans text-xs text-on-surface-variant font-normal">({hint})</span>
        )}
        {scopeIndicator ?? (scope ? <ScopeBadge scope={scope} /> : null)}
      </div>
      {children}
      {helper && (
        <p className="font-sans text-xs text-on-surface-variant">{helper}</p>
      )}
      {error && (
        <p className="flex items-center gap-1 font-sans text-xs text-tertiary">
          <AlertCircle className="h-3 w-3" />
          Save failed: {error}
        </p>
      )}
    </div>
  );
}
