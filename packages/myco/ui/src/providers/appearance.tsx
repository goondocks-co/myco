import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
  /** Merged values currently applied to the document. Appearance is Grove-owned. */
  effective: Appearance;
  /** Patch a single appearance key into the current Grove and refetch. */
  set<K extends keyof Appearance>(key: K, value: Appearance[K]): Promise<void>;
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
  const { effective: cfg, setField } = useScopedConfig();

  const effective: Appearance = useMemo(
    () => ((cfg?.appearance as Appearance | undefined) ?? DEFAULT_APPEARANCE),
    [cfg?.appearance],
  );
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;

  useLayoutEffect(() => {
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
    async (key, value) => {
      const previous = effectiveRef.current;
      const next = { ...previous, [key]: value };
      applyAppearance(next);
      persistAppearance(next);
      try {
        await setField(`appearance.${key}`, value, 'grove');
      } catch (err) {
        applyAppearance(previous);
        persistAppearance(previous);
        throw err;
      }
    },
    [setField],
  );

  const value = useMemo<AppearanceContextValue>(
    () => ({
      effective,
      set,
    }),
    [effective, set],
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
