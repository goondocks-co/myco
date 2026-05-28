import { useState, useEffect, type ReactNode } from 'react';
import { Monitor, Moon, Sun, Check, ChevronDown } from 'lucide-react';
import {
  APPEARANCE_THEMES,
  APPEARANCE_MODES,
  APPEARANCE_FONTS,
  APPEARANCE_DENSITIES,
} from '@myco/config/appearance-values';
import { CONFIG_SECTION_IDS, configFieldId } from '@myco/config/focus';
import {
  useAppearance,
  type Theme,
  type Mode,
  type FontKey,
  type Appearance,
} from '../providers/appearance';
import { ScopeBadge } from '../components/config/ScopePill';

const THEME_LABELS: Record<Theme, { label: string; swatch: string }> = {
  sage: { label: 'Sage', swatch: '#abcfb8' },
  moss: { label: 'Moss', swatch: '#9ca884' },
  terracotta: { label: 'Terracotta', swatch: '#d28a73' },
  dusk: { label: 'Dusk', swatch: '#8faed1' },
  plum: { label: 'Plum', swatch: '#b59ec8' },
  slate: { label: 'Slate', swatch: '#a6b0b8' },
};

const MODE_META: Record<Mode, { icon: typeof Sun; label: string }> = {
  light: { icon: Sun, label: 'Light' },
  dark: { icon: Moon, label: 'Dark' },
  system: { icon: Monitor, label: 'System' },
};

const FONT_LABELS: Record<FontKey, string> = {
  default: 'Default',
  'geist-mono': 'Geist',
  system: 'System',
  'sf-mono': 'SF Mono',
  'fira-code': 'Fira Code',
  'jetbrains-mono': 'JetBrains',
};

const SECTION_EXPANDED_KEY = 'myco-ui-appearance-expanded';

function readSectionExpanded(): boolean {
  // Default expanded so first-time users discover the controls; once they
  // collapse it, the choice persists across sessions.
  const stored = typeof window !== 'undefined' ? localStorage.getItem(SECTION_EXPANDED_KEY) : null;
  return stored === null ? true : stored === 'true';
}

export function AppearanceSection({ collapsed }: { collapsed: boolean }) {
  const { effective, set } = useAppearance();
  const [expanded, setExpanded] = useState<boolean>(readSectionExpanded);

  useEffect(() => {
    localStorage.setItem(SECTION_EXPANDED_KEY, String(expanded));
  }, [expanded]);

  const setGrove = <K extends keyof Appearance>(key: K, value: Appearance[K]) => {
    set(key, value).catch((err) => console.error('[appearance] grove write failed', err));
  };

  // Collapsed sidebar hides section; no icon-mode affordance.
  if (collapsed) return null;

  const controlRow = <K extends keyof Appearance>(
    label: string,
    controlKey: K,
    children: ReactNode,
  ) => (
    <div
      id={configFieldId(`appearance.${controlKey}`)}
      data-config-field={`appearance.${controlKey}`}
      className="rounded-md transition-all duration-300"
    >
      <div className="flex items-center text-xs text-on-surface-variant">
        {label}
        <ScopeBadge scope="grove" />
      </div>
      {children}
    </div>
  );

  return (
    <div
      id={CONFIG_SECTION_IDS.appearance}
      className={`rounded-md border border-[var(--ghost-border)] p-3 ${expanded ? 'space-y-3' : ''}`}
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="-m-1 flex flex-1 items-center gap-1.5 rounded p-1 text-left hover:bg-surface-container-high"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse appearance section' : 'Expand appearance section'}
        >
          <ChevronDown className={`h-3 w-3 text-on-surface-variant transition-transform ${expanded ? '' : '-rotate-90'}`} />
          <h3 className="text-[10px] uppercase tracking-[0.22em] text-on-surface-variant">Appearance</h3>
        </button>
      </div>

      {expanded && (
        <>
          {controlRow('Color theme', 'theme', (
            <div className="mt-2 grid grid-cols-6 gap-1.5">
              {APPEARANCE_THEMES.map((key) => {
                const meta = THEME_LABELS[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setGrove('theme', key)}
                    title={meta.label}
                    aria-label={meta.label}
                    className={`relative aspect-square rounded-md border ${effective.theme === key ? 'border-primary' : 'border-[var(--ghost-border)]'}`}
                    style={{ backgroundColor: meta.swatch }}
                  >
                    {effective.theme === key && <Check className="absolute inset-0 m-auto h-3 w-3 text-on-surface" />}
                  </button>
                );
              })}
            </div>
          ))}

          {controlRow('Mode', 'mode', (
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {APPEARANCE_MODES.map((key) => {
                const { icon: Icon, label } = MODE_META[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setGrove('mode', key)}
                    className={`flex items-center justify-center gap-1 rounded-md border py-1 text-xs ${effective.mode === key ? 'border-primary text-on-surface' : 'border-[var(--ghost-border)] text-on-surface-variant'}`}
                    aria-label={label}
                  >
                    <Icon className="h-3 w-3" /> {label}
                  </button>
                );
              })}
            </div>
          ))}

          {controlRow('Font', 'font', (
            <select
              value={effective.font}
              onChange={(e) => setGrove('font', e.target.value as FontKey)}
              className="mt-2 h-8 w-full rounded-md border border-[var(--ghost-border)] bg-[var(--surface-container-lowest)] px-2 text-xs"
            >
              {APPEARANCE_FONTS.map((key) => (
                <option key={key} value={key}>{FONT_LABELS[key]}</option>
              ))}
            </select>
          ))}

          {controlRow('Density', 'density', (
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {APPEARANCE_DENSITIES.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setGrove('density', key)}
                  className={`rounded-md border py-1 text-xs capitalize ${effective.density === key ? 'border-primary text-on-surface' : 'border-[var(--ghost-border)] text-on-surface-variant'}`}
                >
                  {key}
                </button>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
