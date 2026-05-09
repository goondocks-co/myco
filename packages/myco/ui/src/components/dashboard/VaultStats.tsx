import { type StatsResponse } from '../../hooks/use-daemon';
import { formatEpochAgo } from '../../lib/format';
import { StatCard } from '../ui/stat-card';
import { useProjectPathBuilder } from '../../hooks/use-project-selection';

export function VaultStats({ stats }: { stats: StatsResponse }) {
  const projectPath = useProjectPathBuilder();

  // Agent tile: the lifetime run count is ambient noise — what matters
  // is whether the agent is active and how recently. Show the relative
  // time as the headline; status as the sublabel; accent reflects state.
  const agentValue = stats.agent.last_run_at
    ? formatEpochAgo(stats.agent.last_run_at)
    : 'Never';
  const agentSublabel = stats.agent.last_run_status ?? '—';

  // Canopy tile: indexed-vs-described is the meaningful state.
  // Total entries as the headline; "X/Y described" as sublabel tells
  // the user whether Canopy has caught up with the codebase.
  const canopyDescribed = stats.canopy.described_count;
  const canopyTotal = stats.canopy.entries_count;
  const canopySublabel = canopyTotal > 0
    ? `${canopyDescribed}/${canopyTotal} described`
    : 'no entries yet';

  // Embedding lives on the Grove Dashboard and uptime/version on the
  // Machine Dashboard now — keep this row to project-scoped stats only.
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard
        label="Sessions"
        value={String(stats.vault.session_count)}
        sublabel={`${stats.daemon.active_sessions.length} active`}
        accent="sage"
        href={projectPath('/sessions')}
      />
      <StatCard
        label="Spores"
        value={String(stats.vault.spore_count)}
        accent="sage"
        href={projectPath('/mycelium?tab=spores')}
      />
      <StatCard
        label="Canopy"
        value={String(canopyTotal)}
        sublabel={canopySublabel}
        accent={canopyTotal > canopyDescribed ? 'ochre' : 'sage'}
        href={projectPath('/cortex?tab=canopy')}
      />
      <StatCard
        label="Agent"
        value={agentValue}
        sublabel={agentSublabel}
        accent={stats.agent.last_run_status === 'error' ? 'terracotta' : 'outline'}
        href={projectPath('/agent')}
      />
    </div>
  );
}
