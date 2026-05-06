import type { AppearanceValues } from '@myco/config/appearance-values';

/**
 * Pre-bootstrap appearance application.
 *
 * The AppearanceProvider hydrates from `/config/merged`, which is async —
 * so the first paint after a hard reload would otherwise flash the
 * default theme until React Query settles. We persist the last-applied
 * values to localStorage and replay them synchronously before React
 * mounts, eliminating the flash.
 *
 * Module is intentionally browser-only and free of React so `main.tsx`
 * can call `applyCachedAppearance()` before `ReactDOM.createRoot()`.
 */

export const APPEARANCE_CACHE_KEY = 'myco-appearance';

const DENSITY_VALUES: Record<AppearanceValues['density'], number> = {
  compact: 0.85,
  normal: 1,
  comfy: 1.15,
};

interface FontStack {
  heading: string;
  ui: string;
  data: string;
}

const FONT_STACKS: Record<AppearanceValues['font'], FontStack> = {
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

const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)';

export function applyAppearance(a: AppearanceValues): void {
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

export function persistAppearance(a: AppearanceValues): void {
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(a));
  } catch {
    // Quota exceeded or storage disabled — silently skip; the next render
    // will still apply the right values once the config fetch resolves.
  }
}

/**
 * Read the last-applied appearance from localStorage and apply it
 * synchronously to the document. Called once from `main.tsx` before React
 * mounts so the user's chosen theme paints on the first frame.
 *
 * No-ops on first ever load (no cache yet) — the AppearanceProvider's
 * effect will paint the real values once the config fetch settles. From
 * the second visit on, the cache satisfies the first paint.
 */
export function applyCachedAppearance(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as AppearanceValues;
    applyAppearance(parsed);
  } catch {
    // Stale or corrupt cache — drop it so we don't keep failing.
    try { localStorage.removeItem(APPEARANCE_CACHE_KEY); } catch { /* ignore */ }
  }
}
