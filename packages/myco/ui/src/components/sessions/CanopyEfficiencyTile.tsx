import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import {
  useSessionCanopy,
  isCanopyAggregateEmpty,
  type SessionCanopyAggregate,
} from '../../hooks/use-canopy';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/**
 * Local-format thresholds. Matches the loose convention used by other tiles
 * (no shared formatter library). Negative net-saved values are rendered with
 * a minus sign so users see when injection cost exceeded gain — honest, not
 * hidden.
 */
const KILO = 1_000;
const MEGA = 1_000_000;

/* ---------- Helpers ---------- */

/**
 * Compact integer formatter: `9999 → 9,999`, `12500 → 12.5k`, `1500000 → 1.5M`.
 * Sign-preserving: `-1234 → -1,234`. Used for the prominent token count.
 */
function formatTokens(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= MEGA) return `${sign}${(abs / MEGA).toFixed(1)}M`;
  if (abs >= KILO * 10) return `${sign}${Math.round(abs / KILO)}k`;
  if (abs >= KILO) return `${sign}${(abs / KILO).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString()}`;
}

/** Pure plain-integer formatter for sub-stat counts. */
function formatCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString();
}

/* ---------- Sub-components ---------- */

/** Single label/value row in the sub-stats stack. */
function SubStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 py-1.5 border-b border-[var(--ghost-border)] last:border-0"
      title={hint}
    >
      <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
        {label}
      </span>
      <span className="font-mono text-xs text-on-surface">{value}</span>
    </div>
  );
}

/* ---------- Component ---------- */

export interface CanopyEfficiencyTileProps {
  sessionId: string;
  /**
 * Test/storybook input: inject an aggregate directly to bypass the network
   * fetch. When provided, the component skips the hook and renders the
   * supplied row exactly as the live hook would. `null` means "no data" and
   * triggers the same hide-gracefully path as a 404 response.
   */
  fixture?: SessionCanopyAggregate | null;
  className?: string;
}

/**
 * Token-efficiency tile for the session detail page.
 *
 * Hides itself entirely when:
 *  - the API returns `null` (404 — no Canopy row or pre-feature session),
 *  - or every aggregate column is `null` (row exists but no outcomes were
 *    captured, e.g. injection disabled in the active scope).
 *
 * No "N/A" placeholder — the design calls for graceful hiding so the
 * surrounding stat-tile row stays clean for sessions that pre-date the
 * feature. When data is present, surface the net savings prominently and
 * back it with the structural sub-stats users need to audit the math.
 */
export function CanopyEfficiencyTile({
  sessionId,
  fixture,
  className,
}: CanopyEfficiencyTileProps) {
  const fixtureProvided = fixture !== undefined;
  const { data: fetched, isLoading } = useSessionCanopy(fixtureProvided ? undefined : sessionId);
  const data = fixtureProvided ? fixture : fetched ?? null;

  // Loading: stay invisible. The tile is non-essential and a flash of empty
  // state is worse than a delayed reveal.
  if (!fixtureProvided && isLoading) return null;

  // Hide-gracefully gate.
  if (isCanopyAggregateEmpty(data)) return null;

  // After the empty-gate, every nullable field is treated as 0 for arithmetic
  // — but the sub-stat row still renders the em-dash for fields that came
  // back as `null`, preserving the distinction between "no data" and "zero".
  const tokensSaved = data!.canopy_tokens_saved ?? 0;
  const offered = data!.canopy_injections_offered;
  const skips = data!.canopy_skips_after_injection;
  const reads = data!.canopy_reads_after_injection;
  const redundant = data!.canopy_redundant_reads;
  const totalTokens = data!.canopy_injection_total_tokens;

  return (
    <Surface
      level="low"
      className={cn(
        'p-4 overflow-hidden rounded-lg border-t-2 border-t-sage',
        'border border-outline-variant/10',
        className,
      )}
      data-testid="canopy-efficiency-tile"
    >
      <SectionHeader className="mb-3">Token efficiency</SectionHeader>

      <div className="mb-4">
        <p
          className={cn(
            'font-serif text-3xl font-bold tracking-tight',
            tokensSaved >= 0 ? 'text-sage' : 'text-terracotta',
          )}
          aria-label={`${formatTokens(tokensSaved)} net tokens saved`}
        >
          {formatTokens(tokensSaved)}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-wider text-outline mt-1">
          net tokens {tokensSaved >= 0 ? 'saved' : 'spent'}
        </p>
      </div>

      <div className="space-y-0">
        <SubStat
          label="Injections offered"
          value={formatCount(offered)}
          hint="PreToolUse Read events where Canopy injected anatomy."
        />
        <SubStat
          label="Skipped after injection"
          value={formatCount(skips)}
          hint="Files the agent did not Read after seeing the injected blob."
        />
        <SubStat
          label="Read anyway"
          value={formatCount(reads)}
          hint="Files the agent Read in full after the injection."
        />
        <SubStat
          label="Injection cost"
          value={totalTokens === null ? '—' : `${formatTokens(totalTokens)} tok`}
          hint="Sum of tokens spent on Canopy injections this session."
        />
        {redundant !== null && redundant > 0 && (
          <SubStat
            label="Redundant reads"
            value={formatCount(redundant)}
            hint="Files Read more than once in this session (informational)."
          />
        )}
      </div>
    </Surface>
  );
}
