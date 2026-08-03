
import { CheckCircle2, KeyRound, XCircle } from 'lucide-react';
import { Panel } from '../ui/panel';
import { IconEyebrow } from '../ui/icon-eyebrow';
import { AccentSurface } from '../ui/accent-surface';
import { AgentProviderCard } from '../settings/AgentProviderCard';
import { EmbeddingCard } from '../settings/EmbeddingCard';
import { TeamTaskProviderConfig } from './TeamTaskProviderConfig';
import {
  TeamConfigTargetProvider,
  useScopedConfig,
  type TeamConfigTarget,
} from '../../hooks/use-scoped-config';

export interface TeamSettingsPanelProps {
  target: TeamConfigTarget;
}

/**
 * Status line for the panel — surfaces `keyHealth` from `GET /api/team/config`
 * (server-mode design spec §5/§6's "no team key configured" signal) so the
 * team knows whether the agent can actually run before they go looking at the
 * provider card below.
 */
function TeamStatusBanner() {
  const { isLoading, isError, keyHealth } = useScopedConfig();

  if (isLoading) {
    return <p className="text-sm text-on-surface-variant m-0">Loading team settings…</p>;
  }

  if (isError) {
    return (
      <AccentSurface accent="terra" padded className="flex items-start gap-3" role="status">
        <XCircle className="size-5 shrink-0 text-terracotta" aria-hidden />
        <p className="m-0 text-sm text-on-surface">
          This host doesn't have team settings available right now.
        </p>
      </AccentSurface>
    );
  }

  const ok = keyHealth === 'ok';
  return (
    <AccentSurface
      accent={ok ? 'sage' : 'terra'}
      padded
      className="flex items-start gap-3"
      role="status"
    >
      {ok ? (
        <CheckCircle2 className="size-5 shrink-0 text-sage" aria-hidden />
      ) : (
        <XCircle className="size-5 shrink-0 text-terracotta" aria-hidden />
      )}
      <p className="m-0 text-sm text-on-surface">
        {ok
          ? 'A team key is configured.'
          : 'No team key configured — set one below so the agent can run for the team.'}
      </p>
    </AccentSurface>
  );
}

/**
 * Team settings — the served grove's grove-tier config, edited from a
 * member's Team page through the team routes (server-mode design spec §6).
 * Reuses the SAME forms the Settings page mounts for a normal project
 * (`AgentProviderCard`, `EmbeddingCard`, `TaskProviderConfig` via
 * `TeamTaskProviderConfig`) unmodified: they read/write through
 * `useScopedConfig()` / `useTaskConfig()` / `useUpdateTaskConfig()`, which
 * all resolve to the team routes for any component rendered inside
 * `TeamConfigTargetProvider` below — no forked copies.
 */
export function TeamSettingsPanel({ target }: TeamSettingsPanelProps) {
  // External access moved to the Team page's own host-scoped tab (E1 §5.2)
  // — this panel is Tab 3's settings surface only.
  return (
    <TeamConfigTargetProvider target={target}>
      <div className="flex flex-col gap-4">
        <Panel
          tone="sage"
          eyebrow={<IconEyebrow Icon={KeyRound}>Team</IconEyebrow>}
          title="Team settings"
        >
          <TeamStatusBanner />
        </Panel>
        <AgentProviderCard />
        <EmbeddingCard />
        <Panel tone="sage" title="Per-task overrides">
          <TeamTaskProviderConfig />
        </Panel>
      </div>
    </TeamConfigTargetProvider>
  );
}

export default TeamSettingsPanel;
