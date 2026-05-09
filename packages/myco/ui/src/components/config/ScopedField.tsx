import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { getAtPath } from '@myco/utils/dot-path';
import { configFieldId } from '@myco/config/focus';
import { useScopedConfig, type Scope } from '../../hooks/use-scoped-config';
import { useMarkRestartDirty } from './restart-gate';
import { ScopePill } from './ScopePill';
import { FieldShell } from './FieldShell';
import type { ConfigPath, ConfigValueAt } from '../../lib/config-paths';

interface ScopedFieldRenderArgs<T> {
  value: T | undefined;
  onChange: (v: T) => void;
  onBlur: () => void;
}

interface ScopedFieldProps<P extends ConfigPath, T = ConfigValueAt<P>> {
  /** Dotted path into MycoConfig — e.g. 'daemon.log_level'. Static paths
   *  autocomplete; dynamic paths (notifications.domains.<id>.enabled) accept
   *  any string via the `(string & {})` escape hatch. */
  path: P;
  label: string;
  hint?: string;
  /** Which scope to write to when this field changes. */
  defaultScope?: Scope;
  /** When set, locks writes to this scope and hides the Personal pill.
   *  Use for fields that are project-only by design (plan dirs, team identity)
   *  or machine-only by design (machine_id overrides etc.). */
  lockScope?: Scope;
  /** When true, flags the page-level restart gate on commit. */
  requiresRestart?: boolean;
  /** Inputs that accept typed text should commit on blur; toggles/selects commit on change. */
  commitOn?: 'change' | 'blur';
  /** Optional transform applied before writing (e.g. string-to-number for text inputs). */
  parse?: (v: T) => T;
  /**
   * Override the inactive-state scope badge. Use 'grove' for settings
   * stored at project scope but applied across every project in the
   * Grove (e.g. log retention, embedded against the shared Grove DB).
   */
  scopeBadgeOverride?: 'personal' | 'project' | 'grove';
  children: (args: ScopedFieldRenderArgs<T>) => ReactNode;
}

export function ScopedField<P extends ConfigPath, T = ConfigValueAt<P>>({
  path,
  label,
  hint,
  defaultScope = 'local',
  lockScope,
  requiresRestart,
  commitOn = 'change',
  parse,
  scopeBadgeOverride,
  children,
}: ScopedFieldProps<P, T>) {
  const { effective: effectiveConfig, local, setField, resetField, promoteField } = useScopedConfig();
  const markRestartDirty = useMarkRestartDirty();

  // Re-derive each render so values stay in sync; use a ref in commit so the
  // callback identity doesn't churn on every refetch (React Query returns a
  // new object reference even when data is unchanged).
  const effective = getAtPath((effectiveConfig ?? {}) as Record<string, unknown>, path) as T | undefined;
  const hasLocalOverride = !lockScope && getAtPath((local ?? {}) as Record<string, unknown>, path) !== undefined;
  const writeScope: Scope = lockScope ?? defaultScope;

  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;

  const [draft, setDraft] = useState<T | undefined>(effective);
  // Snap draft back to effective when an external write changes the value
  // (another tab, promote/reset, etc). The ref guard prevents clobbering an
  // in-flight local edit on every parent re-render.
  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current) setDraft(effective);
  }, [effective]);

  const [error, setError] = useState<string | null>(null);

  const commit = useCallback(
    (value: T) => {
      const toWrite = parse ? parse(value) : value;
      if (toWrite === effectiveRef.current) return;
      setError(null);
      void setField(path, toWrite, writeScope).then(() => {
        if (requiresRestart) markRestartDirty(path);
      }).catch((err) => {
        // On failure, snap draft back and surface the error inline. Without
        // a visible indicator a swallowed write looks identical to a no-op,
        // which Chris flagged in /simplify review #6.
        setDraft(effectiveRef.current);
        setError(err instanceof Error ? err.message : String(err));
        console.error(`[scoped-field] write failed for ${path}`, err);
      });
    },
    [path, writeScope, parse, requiresRestart, setField, markRestartDirty],
  );

  const handleChange = useCallback(
    (v: T) => {
      editingRef.current = true;
      setDraft(v);
      if (commitOn === 'change') {
        commit(v);
        editingRef.current = false;
      }
    },
    [commit, commitOn],
  );

  const handleBlur = useCallback(() => {
    if (commitOn === 'blur' && draft !== undefined) commit(draft);
    editingRef.current = false;
  }, [commit, commitOn, draft]);

  const indicator = hasLocalOverride ? (
    <ScopePill
      onPromote={() => promoteField(path).catch((err) => console.error('[scoped-field] promote failed', err))}
      onReset={() => resetField(path).catch((err) => console.error('[scoped-field] reset failed', err))}
    />
  ) : undefined;

  return (
    <div id={configFieldId(path)} data-config-field={path} className="rounded-md transition-all duration-300">
      <FieldShell
        label={label}
        hint={hint}
        scope={scopeBadgeOverride ?? (lockScope === 'local' ? 'personal' : 'project')}
        scopeIndicator={indicator}
        error={error ?? undefined}
      >
        {children({ value: draft, onChange: handleChange, onBlur: handleBlur })}
      </FieldShell>
    </div>
  );
}
