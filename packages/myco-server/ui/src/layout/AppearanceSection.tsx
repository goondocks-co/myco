import { Monitor, Moon, Sun } from 'lucide-react';
import { APPEARANCE_DENSITIES, APPEARANCE_FONTS, APPEARANCE_THEMES } from '../lib/appearance-values';
import { useAppearance, type Density, type FontKey, type Mode, type Theme } from '../providers/appearance';
import { cn } from '../lib/cn';

const THEME_SWATCH: Record<Theme, string> = {
  sage: '#abcfb8',
  moss: '#9ca884',
  terracotta: '#d28a73',
  dusk: '#8faed1',
  plum: '#b59ec8',
  slate: '#a6b0b8',
};

const MODE_ICON: Record<Mode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

const FONT_LABEL: Record<FontKey, string> = {
  default: 'Default',
  'geist-mono': 'Geist',
  system: 'System',
  'sf-mono': 'SF Mono',
  'fira-code': 'Fira Code',
  'jetbrains-mono': 'JetBrains',
};

const DENSITY_LABEL: Record<Density, string> = { compact: 'Compact', normal: 'Normal', comfy: 'Comfy' };

/** This viewer's theme, mode, font and density. */
export function AppearanceSection() {
  const { effective, set } = useAppearance();
  return (
    <div className="flex flex-col gap-3 font-sans text-xs text-on-surface-variant">
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Theme">
        {APPEARANCE_THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            role="radio"
            aria-checked={effective.theme === theme}
            aria-label={theme}
            title={theme}
            onClick={() => set('theme', theme)}
            className={cn(
              'h-4 w-4 rounded-full border transition-transform',
              effective.theme === theme ? 'scale-110 border-on-surface' : 'border-transparent',
            )}
            style={{ backgroundColor: THEME_SWATCH[theme] }}
          />
        ))}
      </div>
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Mode">
        {(Object.keys(MODE_ICON) as Mode[]).map((mode) => {
          const Icon = MODE_ICON[mode];
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={effective.mode === mode}
              aria-label={mode}
              onClick={() => set('mode', mode)}
              className={cn(
                'rounded-md p-1.5 transition-colors hover:bg-surface-container-high',
                effective.mode === mode && 'bg-surface-container-high text-on-surface',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>
      <label className="flex items-center justify-between gap-2">
        <span>Font</span>
        <select
          value={effective.font}
          onChange={(e) => set('font', e.target.value as FontKey)}
          className="rounded-md border border-outline-variant/30 bg-surface-container px-1.5 py-1 text-on-surface"
        >
          {APPEARANCE_FONTS.map((font) => (
            <option key={font} value={font}>{FONT_LABEL[font]}</option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Density">
        {APPEARANCE_DENSITIES.map((density) => (
          <button
            key={density}
            type="button"
            role="radio"
            aria-checked={effective.density === density}
            onClick={() => set('density', density)}
            className={cn(
              'rounded-md px-2 py-1 transition-colors hover:bg-surface-container-high',
              effective.density === density && 'bg-surface-container-high text-on-surface',
            )}
          >
            {DENSITY_LABEL[density]}
          </button>
        ))}
      </div>
    </div>
  );
}
