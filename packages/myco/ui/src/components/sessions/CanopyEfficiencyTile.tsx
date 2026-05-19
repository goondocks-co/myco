import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  useSessionCanopy,
  getMycoToolCallCount,
  type SessionCanopyAggregate,
} from '../../hooks/use-canopy';
import { cn } from '../../lib/cn';

/** Cortex page hosts the Canopy settings + the canonical feature description. */
const CANOPY_SETTINGS_HREF = '/cortex?tab=canopy';

/* ---------- Constants ---------- */

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

function formatCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString();
}

/* ---------- Sub-components ---------- */

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
   * still renders the tile (with zeros) — matches the live behavior for
   * pre-feature sessions and non-Claude symbionts where Canopy can't yet
   * report meaningful numbers.
   */
  fixture?: SessionCanopyAggregate | null;
  className?: string;
}

/**
 * Compact StatCard-shaped tile reporting Canopy's per-Read injection
 * outcomes. Slots into the session detail's stat-card row (sibling of
 * Prompts/Tool Calls/Plans). Click opens a modal with the full breakdown
 * and a link out to the Cortex → Canopy settings page, which owns the
 * full description of what Canopy is and what it measures (so this tile
 * doesn't have to re-state scope on every session detail page).
 *
 * Always rendered, including when:
 *  - the agent has no PreToolUse injection surface (codex, cursor, gemini,
 *    windsurf, opencode, pi, vscode-copilot — they get zeros today),
 *  - the API returns `null` (pre-feature session),
 *  - or every aggregate column is `null`.
 *
 * Zeros aren't hidden because the tile is small enough to live with them,
 * and they set the stage for cross-symbiont measurement once we have
 * other ways to attribute Myco's token spend (cortex, spore injection)
 * and savings to a session.
 *
 * Scope: the displayed number is direct savings from skipped Reads after
 * PreToolUse injection on Claude Code. The Cortex → Canopy settings page
 * is the canonical place where this scope is explained — the modal links
 * out to it instead of duplicating the description.
 */
export function CanopyEfficiencyTile({
  sessionId,
  fixture,
  className,
}: CanopyEfficiencyTileProps) {
  const [open, setOpen] = useState(false);
  const fixtureProvided = fixture !== undefined;
  const { data: fetched, isLoading } = useSessionCanopy(
    fixtureProvided ? undefined : sessionId,
  );
  const data = fixtureProvided ? fixture : fetched ?? null;

  if (!fixtureProvided && isLoading) return null;

  const tokensSaved = data?.canopy_tokens_saved ?? 0;
  const offered = data?.canopy_injections_offered ?? null;
  const skips = data?.canopy_skips_after_injection ?? null;
  const reads = data?.canopy_reads_after_injection ?? null;
  const redundant = data?.canopy_redundant_reads ?? null;
  const totalTokens = data?.canopy_injection_total_tokens ?? null;
  // Map calls is sourced from the per-(tool, op) `myco_tool_calls` map the
  // daemon now returns on this endpoint. Pre-feature sessions (where data is
  // null, or where Stop hasn't materialized yet) report `0` here — same shape
  // the live session would show before the agent has called canopy_map().
  // Replaces the prior `data?.canopy_map_tool_calls ?? 0` read, which depended
  // on a dispatch-time counter that silently zeroed for several symbionts.
  const mapCalls = getMycoToolCallCount(data, 'myco_cortex', 'canopy_map');

  const skipRatio =
    offered !== null && offered > 0 && skips !== null
      ? `${skips}/${offered} skipped`
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'rounded-lg border border-outline-variant/10 bg-surface-container/60 p-4 border-t-2 border-t-sage',
          'transition-[border-color,background-color] duration-200',
          'hover:border-outline-variant/25 hover:bg-surface-container/80 cursor-pointer text-left',
          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sage/40',
          className,
        )}
        data-testid="canopy-efficiency-tile"
        aria-label={`${formatTokens(tokensSaved)} tokens saved by Canopy. Click for breakdown.`}
      >
        <p className="font-mono text-[10px] uppercase tracking-wider text-outline mb-2">
          Reads saved
        </p>
        <div className="flex items-end justify-between gap-2">
          <p
            className={cn(
              'font-serif text-2xl font-bold',
              tokensSaved >= 0 ? 'text-sage' : 'text-terracotta',
            )}
          >
            {formatTokens(tokensSaved)}
          </p>
        </div>
        {skipRatio && (
          <p className="font-mono text-[10px] text-outline mt-1">{skipRatio}</p>
        )}
        {/*
          Secondary metric: canopy_map() tool calls in this session. Rendered
          as a small, separate line beneath the headline — explicitly NOT
          folded into "tokens saved" because the two count different things
          (per-Read injection savings vs. agent-driven map lookups).
        */}
        <p
          className="font-mono text-[10px] text-outline mt-1"
          data-testid="canopy-map-calls"
        >
          Map calls: {mapCalls}
        </p>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Canopy: Reads saved this session</DialogTitle>
            <DialogDescription>
              Direct token savings from files the agent skipped Reading after
              Canopy injected file anatomy via PreToolUse.
            </DialogDescription>
          </DialogHeader>

          <div className="mb-4">
            <p
              className={cn(
                'font-serif text-3xl font-bold tracking-tight',
                tokensSaved >= 0 ? 'text-sage' : 'text-terracotta',
              )}
              aria-label={`${formatTokens(tokensSaved)} net tokens saved on Reads`}
            >
              {formatTokens(tokensSaved)}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-wider text-outline mt-1">
              net tokens {tokensSaved >= 0 ? 'saved on reads' : 'spent on injections'}
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
            <SubStat
              label="Map calls"
              value={mapCalls.toLocaleString()}
              hint="Times the agent called canopy_map() during this session."
            />
          </div>

          <Link
            to={CANOPY_SETTINGS_HREF}
            onClick={() => setOpen(false)}
            className="inline-block mt-4 font-mono text-xs text-sage hover:underline"
          >
            Learn more about Canopy →
          </Link>
        </DialogContent>
      </Dialog>
    </>
  );
}
