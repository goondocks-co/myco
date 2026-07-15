import { useCallback, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, XCircle } from 'lucide-react';
import { Panel } from '../ui/panel';
import { IconEyebrow } from '../ui/icon-eyebrow';
import { Button } from '../ui/button';
import { AccentSurface } from '../ui/accent-surface';
import { AgentProviderCard } from '../settings/AgentProviderCard';
import { EmbeddingCard } from '../settings/EmbeddingCard';
import { TeamTaskProviderConfig } from './TeamTaskProviderConfig';
import {
  TeamConfigTargetProvider,
  useScopedConfig,
  type TeamConfigTarget,
} from '../../hooks/use-scoped-config';
import { postJson } from '../../lib/api';

export interface TeamSettingsPanelProps {
  target: TeamConfigTarget;
}

interface RotateTokenResponse {
  tokenHash: string;
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
 * Rotates the external access token (Task 8's thin seam — `POST
 * /api/team/mcp-token/rotate`). The value itself is never revealed here: the
 * response is a non-secret change-detection hash only. Task 10 builds the
 * listener this token gates and the reveal channel for the raw value; this
 * button lands early because rotation itself is a complete, low-risk action
 * on its own.
 */
function RotateAccessTokenButton() {
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [hash, setHash] = useState<string | null>(null);

  const handleRotate = useCallback(async () => {
    setStatus('pending');
    try {
      const result = await postJson<RotateTokenResponse>('/team/mcp-token/rotate');
      setHash(result.tokenHash);
      setStatus('done');
    } catch {
      setStatus('error');
    }
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="ghost" size="sm" onClick={handleRotate} disabled={status === 'pending'}>
        {status === 'pending' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Rotate external access token
      </Button>
      {status === 'done' && hash && (
        <span className="font-mono text-xs text-on-surface-variant">rotated · {hash}</span>
      )}
      {status === 'error' && <span className="text-xs text-tertiary">Rotate failed.</span>}
    </div>
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
        <Panel tone="sage" title="External access">
          <p className="text-xs text-on-surface-variant m-0 mb-3">
            Rotating replaces the token used by tools outside the team's machines. Existing
            connections stop working until they're updated with the new token.
          </p>
          <RotateAccessTokenButton />
        </Panel>
      </div>
    </TeamConfigTargetProvider>
  );
}

export default TeamSettingsPanel;
