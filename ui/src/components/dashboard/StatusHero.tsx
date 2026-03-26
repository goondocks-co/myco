import { type StatsResponse } from '../../hooks/use-daemon';
import { formatUptime } from '../../lib/format';

/* ---------- Constants ---------- */

const CONNECTIVITY_FULL = 100;
const CONNECTIVITY_PRECISION = 1;

/* ---------- Helpers ---------- */

function computeConnectivity(stats: StatsResponse): number {
  const { embedded_count, total_embeddable } = stats.embedding;
  if (total_embeddable === 0) return CONNECTIVITY_FULL;
  return Number(
    ((embedded_count / total_embeddable) * CONNECTIVITY_FULL).toFixed(CONNECTIVITY_PRECISION),
  );
}

function healthSubtitle(stats: StatsResponse): string {
  const hasErrors = stats.agent.last_run_status === 'error';
  const hasWarnings = stats.embedding.queue_depth > 0 || stats.unprocessed_batches > 0;

  if (hasErrors) return 'Issues detected in the network';
  if (hasWarnings) return 'Work in progress across the network';
  return 'Network Topology Active';
}

function isProcessing(stats: StatsResponse): boolean {
  return stats.embedding.queue_depth > 0 || stats.unprocessed_batches > 0;
}

/* ---------- SVG Decoration ---------- */

function MycelialTree({ active }: { active: boolean }) {
  const pulseClass = active ? 'animate-pulse-slow' : '';
  return (
    <svg
      className="absolute inset-0 w-full h-full opacity-20 pointer-events-none"
      viewBox="0 0 400 300"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* Main trunk */}
      <path d="M200,280 Q200,220 200,160" fill="none" stroke="var(--primary)" strokeWidth="2" className={pulseClass} />
      {/* Right branch */}
      <path d="M200,200 Q240,170 280,180" fill="none" stroke="var(--primary)" strokeWidth="1.5" className={pulseClass} />
      {/* Left branch */}
      <path d="M200,170 Q160,140 120,155" fill="none" stroke="var(--primary)" strokeWidth="1.5" className={pulseClass} />
      {/* Upper right */}
      <path d="M200,160 Q230,110 270,90" fill="none" stroke="var(--secondary)" strokeWidth="1" className={pulseClass} />
      {/* Upper left */}
      <path d="M200,160 Q170,110 130,80" fill="none" stroke="var(--secondary)" strokeWidth="1" className={pulseClass} />
      {/* Far branches — terracotta */}
      <path d="M280,180 Q310,170 340,190" fill="none" stroke="var(--tertiary)" strokeWidth="0.8" opacity="0.5" />
      <path d="M120,155 Q90,145 60,160" fill="none" stroke="var(--tertiary)" strokeWidth="0.8" opacity="0.5" />
      {/* Node dots — mixed colors */}
      <circle cx="280" cy="180" r="3" fill="var(--primary)" opacity="0.7" />
      <circle cx="120" cy="155" r="3" fill="var(--secondary)" opacity="0.7" />
      <circle cx="270" cy="90" r="2.5" fill="var(--tertiary)" opacity="0.6" />
      <circle cx="130" cy="80" r="2.5" fill="var(--secondary)" opacity="0.6" />
      <circle cx="340" cy="190" r="2" fill="var(--tertiary)" opacity="0.4" />
      <circle cx="60" cy="160" r="2" fill="var(--primary)" opacity="0.4" />
      {/* Center node */}
      <circle cx="200" cy="160" r="4" fill="var(--primary)" className={active ? 'animate-pulse' : ''} />
    </svg>
  );
}

/* ---------- Component ---------- */

export function StatusHero({ stats }: { stats: StatsResponse }) {
  const connectivity = computeConnectivity(stats);
  const subtitle = healthSubtitle(stats);
  const active = isProcessing(stats);
  const activeSessions = stats.daemon.active_sessions.length;
  const uptime = formatUptime(stats.daemon.uptime_seconds);

  return (
    <section className="relative flex items-center justify-center rounded-xl overflow-hidden glass-panel border border-outline-variant/10 min-h-[320px]">
      <MycelialTree active={active} />

      <div className="text-center relative z-20 space-y-3 py-12">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/80">
          {subtitle}
        </span>

        <h1 className="font-serif text-5xl italic text-on-surface drop-shadow-sm">
          Myco
        </h1>

        <p className="font-mono text-sm text-outline">
          Node connectivity at {connectivity}% capacity
        </p>

        {/* Stat pills */}
        <div className="flex items-center justify-center gap-6 pt-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-sage shadow-sage-glow animate-pulse" />
            <span className="font-mono text-[11px] text-on-surface/70">
              {activeSessions} active {activeSessions === 1 ? 'session' : 'sessions'}
            </span>
          </div>
          <div className="h-3 w-px bg-outline-variant/30" />
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-on-surface/70">
              {stats.vault.spore_count} spores
            </span>
          </div>
          <div className="h-3 w-px bg-outline-variant/30" />
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-on-surface/70">
              uptime {uptime}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
