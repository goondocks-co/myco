import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useScopedConfig } from '../hooks/use-scoped-config';
import { applyAppearance, persistAppearance } from '../lib/appearance-apply';
import type { AppearanceValues } from '@myco/config/appearance-values';

export type Theme = AppearanceValues['theme'];
export type Mode = AppearanceValues['mode'];
export type FontKey = AppearanceValues['font'];
export type Density = AppearanceValues['density'];
export type Appearance = AppearanceValues;

interface AppearanceContextValue {
  /** Merged values currently applied to the document (project + local overlay). */
  effective: Appearance;
  /** Raw local overrides — keys present here are "sticky" per machine. */
  local: Partial<Appearance>;
  /** Patch a single appearance key into the given scope and refetch. */
  set<K extends keyof Appearance>(
    key: K,
    value: Appearance[K],
    scope: 'local' | 'project',
  ): Promise<void>;
  /** Drop a single key from local overrides so the project value shines through. */
  resetKey<K extends keyof Appearance>(key: K): Promise<void>;
  /** Promote the current effective appearance into the project config. */
  saveAllAsProject(): Promise<void>;
  /** Remove all local appearance overrides. */
  resetAll(): Promise<void>;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

const DEFAULT_APPEARANCE: Appearance = {
  theme: 'sage',
  mode: 'dark',
  font: 'default',
  density: 'normal',
};

const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)';

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { effective: cfg, local: localCfg, setField, resetField, promoteField } = useScopedConfig();

  const effective: Appearance = useMemo(
    () => ((cfg?.appearance as Appearance | undefined) ?? DEFAULT_APPEARANCE),
    [cfg?.appearance],
  );

  const localAppearance = useMemo(
    () => (localCfg.appearance ?? {}) as Partial<Appearance>,
    [localCfg.appearance],
  );

  useEffect(() => {
    // Only paint when the config fetch has resolved. The pre-bootstrap
    // script in `main.tsx` already applied the cached values
    // synchronously; running `applyAppearance(DEFAULT_APPEARANCE)` here
    // while the fetch is in flight would clobber that cache with the
    // sage/dark fallback for the duration of the fetch — exactly the
    // flash we're trying to eliminate.
    if (!cfg?.appearance) return;
    applyAppearance(effective);
    persistAppearance(effective);
  }, [effective, cfg?.appearance]);

  // System-mode follow: re-apply when the OS scheme flips.
  useEffect(() => {
    if (effective.mode !== 'system') return;
    const mql = window.matchMedia(LIGHT_MEDIA_QUERY);
    const listener = () => applyAppearance(effective);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [effective]);

  const set: AppearanceContextValue['set'] = useCallback(
    (key, value, scope) => setField(`appearance.${key}`, value, scope),
    [setField],
  );

  const resetKey: AppearanceContextValue['resetKey'] = useCallback(
    (key) => resetField(`appearance.${key}`),
    [resetField],
  );

  // Promote the WHOLE appearance block to project — single atomic write +
  // local-clear via promoteField, which already does both steps.
  const saveAllAsProject = useCallback(
    () => promoteField('appearance'),
    [promoteField],
  );

  // Reset all appearance overrides by clearing the entire local subtree.
  const resetAll = useCallback(
    () => resetField('appearance'),
    [resetField],
  );

  const value = useMemo<AppearanceContextValue>(
    () => ({
      effective,
      local: localAppearance,
      set,
      resetKey,
      saveAllAsProject,
      resetAll,
    }),
    [effective, localAppearance, set, resetKey, saveAllAsProject, resetAll],
  );

  return (
    <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) {
    throw new Error('useAppearance must be used inside AppearanceProvider');
  }
  return ctx;
}
