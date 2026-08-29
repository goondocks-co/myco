import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { APPEARANCE_CACHE_KEY, applyAppearance, persistAppearance } from '../lib/appearance-apply';
import { DEFAULT_APPEARANCE, type AppearanceValues } from '../lib/appearance-values';

export type Theme = AppearanceValues['theme'];
export type Mode = AppearanceValues['mode'];
export type FontKey = AppearanceValues['font'];
export type Density = AppearanceValues['density'];
export type Appearance = AppearanceValues;

interface AppearanceContextValue {
  /** The values applied to the document. Appearance is this viewer's own, held in the browser. */
  effective: Appearance;
  /** Change one appearance key for this viewer. */
  set<K extends keyof Appearance>(key: K, value: Appearance[K]): void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)';

function readStored(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    return { ...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as Partial<Appearance>) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [effective, setEffective] = useState<Appearance>(readStored);

  useLayoutEffect(() => {
    applyAppearance(effective);
    persistAppearance(effective);
  }, [effective]);

  useEffect(() => {
    if (effective.mode !== 'system') return;
    const mql = window.matchMedia(LIGHT_MEDIA_QUERY);
    const listener = () => applyAppearance(effective);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [effective]);

  const set = useCallback(<K extends keyof Appearance>(key: K, value: Appearance[K]) => {
    setEffective((previous) => ({ ...previous, [key]: value }));
  }, []);

  const value = useMemo<AppearanceContextValue>(() => ({ effective, set }), [effective, set]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used inside AppearanceProvider');
  return ctx;
}
