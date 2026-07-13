import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { getAtPath } from '@myco/utils/dot-path';
import { configFieldId } from '@myco/config/focus';
import { useIsTeamConfigTarget, useScopedConfig, type Scope } from '../../hooks/use-scoped-config';
import { useMarkRestartDirty } from './restart-gate';
import { ScopePill } from './ScopePill';
import { FieldShell } from './FieldShell';
import { scopePolicyForPath } from '../../config/scope-policy';
import type { ConfigPath, ConfigValueAt } from '../../lib/config-paths';

interface ScopedFieldRenderArgs<T> {
  value: T | undefined;
  onChange: (v: T) => void;
  onBlur: () => void;
}

interface ScopedFieldProps<P extends ConfigPath, T = ConfigValueAt<P>> {
  /** Dotted path into MycoConfig — e.g. 'daemon.log_level'. Static paths
   *  autocomplete; dynamic paths (notifications.domains.<id>.enabled) accept
   *  any string via the `(string & {})` escape hatch.
   *
   *  Scope is derived entirely from this path via `scopePolicyForPath` — the
   *  registry supplies the home (write) tier and whether a Personal override
   *  is offered. No per-field scope props. */
  path: P;
  label: string;
  hint?: string;
  /** When true, flags the page-level restart gate on commit. */
  requiresRestart?: boolean;
  /** Inputs that accept typed text should commit on blur; toggles/selects commit on change. */
  commitOn?: 'change' | 'blur';
  /** Optional transform applied before writing (e.g. string-to-number for text inputs). */
  parse?: (v: T) => T;
  children: (args: ScopedFieldRenderArgs<T>) => ReactNode;
}

/** Home tier → the static-badge scope used when no Personal pill renders. */
const HOME_TIER_STATIC_BADGE: Record<string, 'personal' | 'project' | 'grove' | 'machine'> = {
  machine: 'machine',
  grove: 'grove',
  project: 'project',
  local: 'personal',
};

export function ScopedField<P extends ConfigPath, T = ConfigValueAt<P>>({
  path,
  label,
  hint,
  requiresRestart,
  commitOn = 'change',
  parse,
  children,
}: ScopedFieldProps<P, T>) {
  const { effective: effectiveConfig, local, setField, resetField } = useScopedConfig();
  const markRestartDirty = useMarkRestartDirty();
  const isTeamTarget = useIsTeamConfigTarget();

  // Scope flows from the registry, never from props. The home tier is the
  // write target; the Personal affordance renders only when the policy lists
  // `local` in `overridableBy` AND the field isn't bound to a served grove —
  // grove-homed Personal overrides are refused by design (spec §6), so a
  // team target always suppresses the opt-in regardless of the registry.
  const policy = scopePolicyForPath(path);
  const allowsPersonal = policy.overridableBy.includes('local') && !isTeamTarget;
  const writeScope = policy.home as Scope;

  // Re-derive each render so values stay in sync; use a ref in commit so the
  // callback identity doesn't churn on every refetch (React Query returns a
  // new object reference even when data is unchanged).
  const effective = getAtPath((effectiveConfig ?? {}) as Record<string, unknown>, path) as T | undefined;
  const hasLocalOverride = allowsPersonal
    && getAtPath((local ?? {}) as Record<string, unknown>, path) !== undefined;

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
        // On failure, snap draft back and surface the error inline; without
        // a visible indicator a swallowed write looks identical to a no-op.
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

  // Personal pill renders only when the registry allows a local override.
  // When it does, the pill renders always: no override → "Save Personal"
  // opt-in writes the effective value to local; override present → "Reset"
  // clears local so the home tier takes effect.
  const indicator: ReactNode = allowsPersonal ? (
    <ScopePill
      path={path}
      hasLocalOverride={hasLocalOverride}
      onSavePersonal={() =>
        setField(path, effectiveRef.current as T, 'local').catch((err) =>
          console.error('[scoped-field] save-personal failed', err),
        )
      }
      onReset={() =>
        resetField(path).catch((err) => console.error('[scoped-field] reset failed', err))
      }
    />
  ) : undefined;

  // When no Personal pill renders (registry locks the field to its home tier,
  // or a team target suppressed it), show a static badge instead — "Team"
  // when bound to a served grove, else the home-tier badge.
  const staticBadge = isTeamTarget ? 'team' : (HOME_TIER_STATIC_BADGE[policy.home] ?? 'project');

  return (
    <div id={configFieldId(path)} data-config-field={path} className="rounded-md transition-all duration-300">
      <FieldShell
        label={label}
        hint={hint}
        scope={indicator ? undefined : staticBadge}
        scopeIndicator={indicator}
        error={error ?? undefined}
      >
        {children({ value: draft, onChange: handleChange, onBlur: handleBlur })}
      </FieldShell>
    </div>
  );
}
