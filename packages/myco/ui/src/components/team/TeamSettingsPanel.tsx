import { useCallback, useEffect, useState } from 'react';
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
import { useHostMembershipStatus } from '../../hooks/use-host-membership';
import { fetchJson, postJson, putJson } from '../../lib/api';

export interface TeamSettingsPanelProps {
  target: TeamConfigTarget;
}

interface RotateTokenResponse {
  token: string;
  tokenHash: string;
}

interface ExternalMcpStatusResponse {
  enabled: boolean;
  tokenHash: string | null;
  bound: boolean | null;
}

interface ExternalMcpToggleResponse {
  enabled: boolean;
  funnel_url?: string | null;
  token?: string;
  tokenHash?: string | null;
}

/**
 * One-time reveal for a freshly minted or rotated access token. The raw
 * value exists ONLY in this response — it is never retrievable again, so the
 * copy affordance is the whole point.
 */
function TokenReveal({ token, note }: { token: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <AccentSurface accent="sage" padded className="flex flex-col gap-2" role="status">
      <p className="m-0 text-xs text-on-surface">{note}</p>
      <div className="flex items-center gap-2">
        <code className="font-mono text-xs break-all text-on-surface">{token}</code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(token).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </AccentSurface>
  );
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
 * External access — turn the public read-only endpoint on or off and manage
 * its token. The raw token appears exactly twice, ever: when turning on
 * mints it, and when rotating replaces it — both one-time reveals with copy.
 */
function ExternalAccessControls() {
  const [status, setStatus] = useState<ExternalMcpStatusResponse | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'rotate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [funnelUrl, setFunnelUrl] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ token: string; note: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchJson<ExternalMcpStatusResponse>('/team/external-mcp'));
      setError(null);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleToggle = useCallback(async () => {
    if (!status) return;
    setBusy('toggle');
    setError(null);
    try {
      const next = !status.enabled;
      const result = await putJson<ExternalMcpToggleResponse>('/team/external-mcp/toggle', { enabled: next });
      if (next) {
        setFunnelUrl(result.funnel_url ?? null);
        if (result.token) {
          setReveal({
            token: result.token,
            note: 'Your external access token — copy it now; it will not be shown again.',
          });
        }
      } else {
        setFunnelUrl(null);
        setReveal(null);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The change did not apply.');
    } finally {
      setBusy(null);
    }
  }, [refresh, status]);

  const handleRotate = useCallback(async () => {
    setBusy('rotate');
    setError(null);
    try {
      const result = await postJson<RotateTokenResponse>('/team/mcp-token/rotate');
      setReveal({
        token: result.token,
        note: 'Your new token — copy it now; it will not be shown again. Tools using the old token stop working immediately.',
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rotate failed.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const enabled = status?.enabled ?? false;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant={enabled ? 'ghost' : 'default'} size="sm" onClick={handleToggle} disabled={busy !== null || status === null}>
          {busy === 'toggle' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {enabled ? 'Turn off external access' : 'Turn on external access'}
        </Button>
        {enabled && (
          <Button type="button" variant="ghost" size="sm" onClick={handleRotate} disabled={busy !== null}>
            {busy === 'rotate' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Rotate token
          </Button>
        )}
        <span className="font-mono text-xs text-on-surface-variant">
          {status === null
            ? 'status unavailable'
            : !enabled
              ? 'off'
              : status.bound === false
                ? 'on · not serving'
                : 'on'}
          {status?.tokenHash ? ` · token ${status.tokenHash}` : ''}
        </span>
      </div>
      {funnelUrl && (
        <p className="m-0 text-xs text-on-surface-variant">
          Public address: <code className="font-mono">{funnelUrl}</code>
        </p>
      )}
      {reveal && <TokenReveal token={reveal.token} note={reveal.note} />}
      {error && <span className="text-xs text-tertiary">{error}</span>}
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
  // External access is refused by the daemon off macOS/Linux (Unix-socket +
  // Funnel activation). Rendering a live toggle that can only 502 is a lying
  // switch — hide the panel when the daemon says the capability is absent.
  // `!== false` keeps older daemons (field absent) rendering as before.
  const membership = useHostMembershipStatus();
  const externalMcpSupported = membership.data?.external_mcp_supported !== false;
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
        {externalMcpSupported && (
          <Panel tone="sage" title="External access">
            <p className="text-xs text-on-surface-variant m-0 mb-3">
              A public, read-only address tools outside the team's machines can use — gated by a
              token. Turning it on mints the token and shows it once; rotating replaces it, and
              existing connections stop working until they're updated.
            </p>
            <ExternalAccessControls />
          </Panel>
        )}
      </div>
    </TeamConfigTargetProvider>
  );
}

export default TeamSettingsPanel;
