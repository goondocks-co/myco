import { type ReactNode } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, ChevronsUpDown, Laptop, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { APPEARANCE_DENSITIES, APPEARANCE_THEMES } from '../../lib/appearance-values';
import { cn } from '../../lib/cn';
import { useAppearance, type Density, type FontKey, type Mode, type Theme } from '../../providers/appearance';
import { focusRing, overlaySurface } from '../lib/classes';
import { Avatar } from '../primitives/Avatar';
import { MenuItem } from '../primitives/MoreMenu';

/** Each accent theme's swatch, as its primary reads in dark mode. */
const THEME_SWATCH: Record<Theme, string> = {
  sage: '#b8c6a0',
  moss: '#9ca884',
  terracotta: '#d5927c',
  dusk: '#8faed1',
  plum: '#b59ec8',
  slate: '#a6b0b8',
};

const THEME_LABEL: Record<Theme, string> = { sage: 'Sage', moss: 'Moss', terracotta: 'Terracotta', dusk: 'Dusk', plum: 'Plum', slate: 'Slate' };

const MODES: ReadonlyArray<{ value: Mode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const DENSITY_LABEL: Record<Density, string> = { compact: 'Compact', normal: 'Normal', comfy: 'Comfy' };

/** The code fonts on offer. `default` is JetBrains Mono; the older `jetbrains-mono` choice reads as it. */
const CODE_FONTS: ReadonlyArray<{ value: FontKey; label: string }> = [
  { value: 'default', label: 'JetBrains Mono' },
  { value: 'geist-mono', label: 'Geist Mono' },
  { value: 'sf-mono', label: 'SF Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'system', label: 'System mono' },
];

const codeFontOf = (font: FontKey): FontKey => (font === 'jetbrains-mono' ? 'default' : font);

export interface AccountMenuProps {
  /** The member's name, shown beside the avatar and heading the menu. */
  name: string;
  /** The GitHub account signed in, without the @. */
  login?: string;
  /** "Admin" or "Member", under the name. */
  role?: string;
  /** Where the member's own machines are listed. */
  machinesHref?: string;
  onSignOut: () => void;
  /** Only the avatar, for a compact header. */
  compact?: boolean;
  align?: 'start' | 'end';
}

const groupLabel = 'px-s2 pb-s1 pt-s2 t-kicker text-faint';

/** A segment in a row of choices: one radio item among a few. */
function Segment({ value, children, label }: { value: string; children: ReactNode; label?: string }) {
  return (
    <Menu.RadioItem
      value={value}
      aria-label={label}
      // The menu stays open, so one visit can set mode, accent and density together.
      onSelect={(event) => event.preventDefault()}
      className={cn(
        'flex h-control-sm flex-1 cursor-default select-none items-center justify-center gap-s1 rounded-chip px-s2 t-small text-ink-2 outline-none',
        'data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink data-[state=checked]:bg-primary-bg data-[state=checked]:text-ink',
      )}
    >
      {children}
    </Menu.RadioItem>
  );
}

/**
 * The account menu on the member's avatar: this browser's appearance (mode,
 * accent, density, code font), the member's machines, and sign out.
 * Appearance is kept in this browser only.
 */
export function AccountMenu({ name, login, role, machinesHref, onSignOut, compact = false, align = 'start' }: AccountMenuProps) {
  const { effective, set } = useAppearance();
  const navigate = useNavigate();
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Account and appearance for ${name}`}
        className={cn(
          'flex min-w-0 items-center gap-s3 rounded-control text-left text-ink-2 transition-colors duration-120 hover:bg-surface-2 hover:text-ink data-[state=open]:bg-surface-2',
          compact ? 'p-s1' : 'h-[44px] w-full px-s2',
          focusRing,
        )}
      >
        <Avatar name={name} aria-hidden />
        {!compact && (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate t-control font-medium text-ink">{name}</span>
              {login != null && login !== '' && <span className="truncate t-meta text-muted">@{login}</span>}
            </span>
            <ChevronsUpDown aria-hidden className="size-s4 shrink-0 text-faint" />
          </>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align={align}
          side={compact ? 'bottom' : 'top'}
          sideOffset={6}
          collisionPadding={8}
          className={cn(overlaySurface, 'z-50 w-[272px] max-w-[calc(100vw-var(--s-4))] p-s1')}
        >
          <Menu.Label className="flex items-center gap-s3 px-s2 py-s2">
            <Avatar name={name} aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="truncate t-control font-medium text-ink">{name}</span>
              <span className="truncate t-meta text-muted">{[login ? `@${login}` : null, role].filter(Boolean).join(' · ')}</span>
            </span>
          </Menu.Label>
          <Menu.Separator className="my-s1 h-px bg-line" />

          <Menu.Label className={groupLabel}>Mode</Menu.Label>
          <Menu.RadioGroup value={effective.mode} onValueChange={(value) => set('mode', value as Mode)} className="flex gap-s1 px-s1">
            {MODES.map(({ value, label, icon: Icon }) => (
              <Segment key={value} value={value}><Icon aria-hidden className="size-s4" />{label}</Segment>
            ))}
          </Menu.RadioGroup>

          <Menu.Label className={groupLabel}>Accent</Menu.Label>
          <Menu.RadioGroup value={effective.theme} onValueChange={(value) => set('theme', value as Theme)} className="flex gap-s1 px-s1">
            {APPEARANCE_THEMES.map((theme) => (
              <Segment key={theme} value={theme} label={THEME_LABEL[theme]}>
                <span
                  aria-hidden
                  className={cn('size-s4 rounded-pill ring-offset-2 ring-offset-surface-2', effective.theme === theme && 'ring-2 ring-ink')}
                  style={{ backgroundColor: THEME_SWATCH[theme] }}
                />
              </Segment>
            ))}
          </Menu.RadioGroup>

          <Menu.Label className={groupLabel}>Density</Menu.Label>
          <Menu.RadioGroup value={effective.density} onValueChange={(value) => set('density', value as Density)} className="flex gap-s1 px-s1">
            {APPEARANCE_DENSITIES.map((density) => <Segment key={density} value={density}>{DENSITY_LABEL[density]}</Segment>)}
          </Menu.RadioGroup>

          <Menu.Sub>
            <Menu.SubTrigger
              className={cn(
                'mt-s2 flex h-control-sm cursor-default select-none items-center gap-s2 rounded-chip px-s2 t-control text-ink-2 outline-none',
                'data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink data-[state=open]:bg-surface-3',
              )}
            >
              <span className="flex-1">Code font</span>
              <span className="t-small text-muted">{CODE_FONTS.find((font) => font.value === codeFontOf(effective.font))?.label}</span>
              <ChevronRight aria-hidden className="size-s4 text-muted" />
            </Menu.SubTrigger>
            <Menu.Portal>
              <Menu.SubContent sideOffset={6} collisionPadding={8} className={cn(overlaySurface, 'z-50 min-w-[192px] p-s1')}>
                <Menu.RadioGroup value={codeFontOf(effective.font)} onValueChange={(value) => set('font', value as FontKey)}>
                  {CODE_FONTS.map((font) => (
                    <Menu.RadioItem
                      key={font.value}
                      value={font.value}
                      className="flex h-control-sm cursor-default select-none items-center gap-s2 rounded-chip px-s2 t-control text-ink-2 outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink"
                    >
                      <span className="flex-1">{font.label}</span>
                      <Menu.ItemIndicator><Check aria-hidden className="size-s4 text-primary" /></Menu.ItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.SubContent>
            </Menu.Portal>
          </Menu.Sub>

          <Menu.Separator className="my-s1 h-px bg-line" />
          {machinesHref != null && (
            <MenuItem onSelect={() => navigate(machinesHref)}>
              <Laptop aria-hidden className="size-s4" />
              My machines
            </MenuItem>
          )}
          <MenuItem onSelect={onSignOut}>
            <LogOut aria-hidden className="size-s4" />
            Sign out
          </MenuItem>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
