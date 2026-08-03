/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * External access — Tab 2 of the Team page (E1 §5.2), promoted from the
 * bottom of the old eleven-panel stack. Every call CARRIES THE TARGET
 * (`teamCarrierHeaders`): these three requests previously sent no context
 * headers at all, so they routed by whatever project the topbar last
 * browsed — Rotate token could rotate a DIFFERENT host's token and show a
 * success banner, and under the machine-scoped route they all silently
 * became local 404s rendered as "status unavailable" (E1 review, PR 3/4).
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Globe, Loader2 } from 'lucide-react';
import { Panel } from '../ui/panel';
import { IconEyebrow } from '../ui/icon-eyebrow';
import { Button } from '../ui/button';
import { AccentSurface } from '../ui/accent-surface';
import { CopyableField } from './CopyableField';
import { teamCarrierHeaders, type TeamConfigTarget } from '../../hooks/use-scoped-config';
import { fetchJson, postJson, putJson } from '../../lib/api';

interface RotateTokenResponse { token: string; tokenHash: string; }
interface ExternalMcpStatusResponse { enabled: boolean; tokenHash: string | null; bound: boolean | null; funnel_url?: string | null; }
interface ExternalMcpToggleResponse { enabled: boolean; funnel_url?: string | null; token?: string; tokenHash?: string | null; }

function TokenReveal({ token, note }: { token: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <AccentSurface accent="sage" padded className="flex flex-col gap-2" role="status">
      <p className="m-0 text-xs text-on-surface">{note}</p>
      <div className="flex items-center gap-2">
        <code className="font-mono text-xs break-all text-on-surface">{token}</code>
        <Button type="button" variant="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(token).then(() => setCopied(true)); }}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </AccentSurface>
  );
}

/** Collapsible ready-to-paste MCP config (recovered old-UI affordance —
 *  the `mcp_servers` JSON shape from docs/team-host.md). */
function McpConfigSnippet({ funnelUrl, tokenKnown }: { funnelUrl: string | null; tokenKnown: boolean }) {
  const [open, setOpen] = useState(false);
  const url = funnelUrl ?? 'https://<your-funnel-address>';
  const snippet = JSON.stringify({
    mcp_servers: {
      'myco-team': {
        url: `${url.replace(/\/$/, '')}/mcp`,
        headers: { authorization: 'Bearer <your access token>' },
      },
    },
  }, null, 2);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="flex items-center gap-1 self-start text-xs text-on-surface-variant hover:text-on-surface transition-colors"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
        Ready-to-paste MCP config
      </button>
      {open && (
        <div className="rounded-md bg-surface-container p-3">
          <CopyableField label="mcp_servers" value={snippet} />
          {!tokenKnown && (
            <p className="m-0 mt-2 text-xs text-on-surface-variant">
              Replace the token placeholder with the access token shown when external access was turned on (or rotate for a new one).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ExternalAccessPanel({ target }: { target: TeamConfigTarget }) {
  const headers = teamCarrierHeaders(target);
  const [status, setStatus] = useState<ExternalMcpStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'rotate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [funnelUrl, setFunnelUrl] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ token: string; note: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchJson<ExternalMcpStatusResponse>('/team/external-mcp', { headers });
      setStatus(next);
      if (next.funnel_url) setFunnelUrl(next.funnel_url);
      setStatusError(null);
    } catch (err) {
      // NEVER a silent null: the old panel swallowed this into "status
      // unavailable" with no cause — the silent-unconfigurable class.
      setStatus(null);
      setStatusError(err instanceof Error ? err.message : 'Status request failed.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.carrier?.hostId ?? 'self']);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleToggle = useCallback(async () => {
    if (!status) return;
    setBusy('toggle');
    setError(null);
    try {
      const next = !status.enabled;
      const result = await putJson<ExternalMcpToggleResponse>('/team/external-mcp/toggle', { enabled: next }, { headers });
      if (next) {
        setFunnelUrl(result.funnel_url ?? null);
        if (result.token) {
          setReveal({ token: result.token, note: 'Your external access token — copy it now; it will not be shown again.' });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, status]);

  const handleRotate = useCallback(async () => {
    setBusy('rotate');
    setError(null);
    try {
      const result = await postJson<RotateTokenResponse>('/team/mcp-token/rotate', undefined, { headers });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const enabled = status?.enabled ?? false;
  return (
    <Panel tone="sage" eyebrow={<IconEyebrow Icon={Globe}>External access</IconEyebrow>} title="External access">
      <p className="text-xs text-on-surface-variant m-0 mb-3">
        A public, read-only address tools outside the team&apos;s machines can use — gated by a token.
        Turning it on mints the token and shows it once; rotating replaces it, and existing
        connections stop working until they&apos;re updated.
      </p>
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
          <span className="font-mono text-xs text-on-surface-variant" data-testid="external-access-status">
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
        {statusError && (
          <p className="m-0 flex items-center gap-2 text-xs text-terracotta" data-testid="external-access-error">
            {statusError}
            <Button type="button" variant="ghost" size="sm" onClick={() => { void refresh(); }}>Retry</Button>
          </p>
        )}
        {funnelUrl && (
          <p className="m-0 text-xs text-on-surface-variant">
            Public address: <code className="font-mono">{funnelUrl}</code>
          </p>
        )}
        {reveal && <TokenReveal token={reveal.token} note={reveal.note} />}
        {enabled && <McpConfigSnippet funnelUrl={funnelUrl} tokenKnown={reveal !== null} />}
        {error && <span className="text-xs text-tertiary">{error}</span>}
      </div>
    </Panel>
  );
}
