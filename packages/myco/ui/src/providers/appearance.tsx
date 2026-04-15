import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchMergedConfig,
  fetchLocalConfig,
  writeScopedConfig,
  clearLocalConfigKeys,
  type AppearanceValues,
} from '../lib/api';

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

const DENSITY_VALUES: Record<Density, number> = {
  compact: 0.85,
  normal: 1,
  comfy: 1.15,
};

interface FontStack {
  heading: string;
  ui: string;
  data: string;
}

const FONT_STACKS: Record<FontKey, FontStack> = {
  default: {
    heading: "'Newsreader', Georgia, serif",
    ui: "'Inter', system-ui, sans-serif",
    data: "'JetBrains Mono', 'Fira Code', monospace",
  },
  'geist-mono': {
    heading: "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
    ui: "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
    data: "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
  },
  system: {
    heading: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    ui: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    data: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  },
  'sf-mono': {
    heading: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace",
    ui: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace",
    data: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace",
  },
  'fira-code': {
    heading: "'Fira Code', 'Fira Mono', ui-monospace, monospace",
    ui: "'Fira Code', 'Fira Mono', ui-monospace, monospace",
    data: "'Fira Code', 'Fira Mono', ui-monospace, monospace",
  },
  'jetbrains-mono': {
    heading: "'JetBrains Mono', ui-monospace, monospace",
    ui: "'JetBrains Mono', ui-monospace, monospace",
    data: "'JetBrains Mono', ui-monospace, monospace",
  },
};

const DEFAULT_APPEARANCE: Appearance = {
  theme: 'sage',
  mode: 'dark',
  font: 'default',
  density: 'normal',
};

const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)';

function applyAppearance(a: Appearance): void {
  const root = document.documentElement;

  root.setAttribute('data-theme', a.theme);

  const effectiveMode =
    a.mode === 'system'
      ? (window.matchMedia(LIGHT_MEDIA_QUERY).matches ? 'light' : 'dark')
      : a.mode;
  root.classList.toggle('light', effectiveMode === 'light');

  const stack = FONT_STACKS[a.font];
  root.style.setProperty('--font-heading', stack.heading);
  root.style.setProperty('--font-ui', stack.ui);
  root.style.setProperty('--font-data', stack.data);

  const density = DENSITY_VALUES[a.density];
  root.style.setProperty('--density', String(density));
  root.style.fontSize = `calc(14px * ${density})`;

  const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  if (link) {
    const nextHref = `/favicon-${a.theme}.svg`;
    if (!link.href.endsWith(nextHref)) link.href = nextHref;
  }
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const merged = useQuery({
    queryKey: ['config', 'merged'],
    queryFn: ({ signal }) => fetchMergedConfig(signal),
  });
  const local = useQuery({
    queryKey: ['config', 'local'],
    queryFn: ({ signal }) => fetchLocalConfig(signal),
  });

  const effective: Appearance = useMemo(
    () => (merged.data?.appearance as Appearance | undefined) ?? DEFAULT_APPEARANCE,
    [
      merged.data?.appearance?.theme,
      merged.data?.appearance?.mode,
      merged.data?.appearance?.font,
      merged.data?.appearance?.density,
    ],
  );

  const localAppearance = useMemo(
    () => (local.data?.appearance ?? {}) as Partial<Appearance>,
    [local.data],
  );

  useEffect(() => {
    applyAppearance(effective);
  }, [effective]);

  useEffect(() => {
    if (effective.mode !== 'system') return;
    const mql = window.matchMedia(LIGHT_MEDIA_QUERY);
    const listener = () => applyAppearance(effective);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [effective]);

  const set: AppearanceContextValue['set'] = useCallback(
    async (key, value, scope) => {
      await writeScopedConfig(scope, { appearance: { [key]: value } });
      await qc.invalidateQueries({ queryKey: ['config'] });
    },
    [qc],
  );

  const resetKey: AppearanceContextValue['resetKey'] = useCallback(
    async (key) => {
      await clearLocalConfigKeys([`appearance.${key}`]);
      await qc.invalidateQueries({ queryKey: ['config'] });
    },
    [qc],
  );

  const saveAllAsProject = useCallback(async () => {
    await writeScopedConfig('project', { appearance: effective });
    await qc.invalidateQueries({ queryKey: ['config'] });
  }, [effective, qc]);

  const resetAll = useCallback(async () => {
    await clearLocalConfigKeys(['appearance']);
    await qc.invalidateQueries({ queryKey: ['config'] });
  }, [qc]);

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
