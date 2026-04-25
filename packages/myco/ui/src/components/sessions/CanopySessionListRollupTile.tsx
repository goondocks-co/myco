import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import {
  useCanopyRollup,
  isCanopyRollupEmpty,
  type CanopyRollup,
} from '../../hooks/use-canopy';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const KILO = 1_000;
const MEGA = 1_000_000;

/* ---------- Helpers ---------- */

/** Compact, sign-preserving integer formatter. */
function formatTokens(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= MEGA) return `${sign}${(abs / MEGA).toFixed(1)}M`;
  if (abs >= KILO * 10) return `${sign}${Math.round(abs / KILO)}k`;
  if (abs >= KILO) return `${sign}${(abs / KILO).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString()}`;
}

/** Render a ratio as a percent like "62%". Returns "—" for null inputs. */
function formatRatio(r: number | null): string {
  if (r === null) return '—';
  return `${Math.round(r * 100)}%`;
}

/* ---------- Sub-components ---------- */

/**
 * One stat in the rollup tile's three-column row. Visual weight is split
 * across the three: same typographic level, no accent variation. The
 * primary "tokens saved" gets a bold serif treatment to draw the eye.
 */
function RollupStat({
  label,
  value,
  primary,
  hint,
}: {
  label: string;
  value: string;
  primary?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1" title={hint}>
      <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
        {label}
      </span>
      <span
        className={cn(
          primary
            ? 'font-serif text-2xl font-bold text-sage tracking-tight'
            : 'font-serif text-xl font-medium text-on-surface',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/* ---------- Component ---------- */

export interface CanopySessionListRollupTileProps {
  /**
   * Test/storybook seam — same pattern as the per-session tile. Pass `null`
   * to exercise the hide-gracefully path.
   */
  fixture?: CanopyRollup | null;
  className?: string;
}

/**
 * Lifetime Canopy rollup tile for the session list surface.
 *
 * Mirrors the hide-gracefully posture of the per-session tile: returns
 * `null` whenever the rollup endpoint 404s OR every numeric field is null
 * (no Canopy data yet on this machine). Otherwise renders three stats —
 * total tokens saved, average per session, and injection effectiveness
 * (skips / injections offered) — in a single tonal card.
 */
export function CanopySessionListRollupTile({
  fixture,
  className,
}: CanopySessionListRollupTileProps) {
  const { data: fetched, isLoading } = useCanopyRollup();
  const fixtureProvided = fixture !== undefined;
  const data = fixtureProvided ? fixture : fetched ?? null;

  if (!fixtureProvided && isLoading) return null;
  if (isCanopyRollupEmpty(data)) return null;

  // Past the empty gate — null fields collapse to 0 for arithmetic.
  const totalSaved = data!.total_tokens_saved ?? 0;
  const avgPerSession = data!.avg_tokens_saved_per_session;
  const ratio = data!.injection_effectiveness_ratio;
  const sessionsCount = data!.sessions_with_canopy;

  return (
    <Surface
      level="low"
      className={cn(
        'p-4 overflow-hidden rounded-lg border-t-2 border-t-sage',
        'border border-outline-variant/10',
        className,
      )}
      data-testid="canopy-rollup-tile"
    >
      <div className="flex items-baseline justify-between mb-3">
        <SectionHeader>Canopy efficiency · lifetime</SectionHeader>
        {sessionsCount !== null && sessionsCount > 0 && (
          <span className="font-mono text-[10px] text-outline">
            across {sessionsCount.toLocaleString()} session{sessionsCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <RollupStat
          label="Tokens saved"
          value={formatTokens(totalSaved)}
          primary
          hint="Net tokens saved by Canopy injections across every captured session."
        />
        <RollupStat
          label="Avg per session"
          value={avgPerSession === null ? '—' : `${formatTokens(Math.round(avgPerSession))} tok`}
          hint="Mean tokens saved per session that had at least one Canopy injection."
        />
        <RollupStat
          label="Injection effectiveness"
          value={formatRatio(ratio)}
          hint="Share of injections where the agent skipped the full Read."
        />
      </div>
    </Surface>
  );
}
