import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bug, Download, CloudOff } from 'lucide-react';
import { fetchJson, ApiError } from '../../lib/api';
import { withBasePath } from '../../lib/base-path';
import { errorMessage } from '../../lib/error';
import { formatBytes, formatEpochAbsolute, SECONDS_PER_HOUR, SECONDS_PER_DAY } from '../../lib/format';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { AccentSurface } from '../ui/accent-surface';
import { HostedUnavailable } from '../ui/hosted-unavailable';
import { hostedDegradedInfo, type HostedDegradedInfo } from '../../lib/degrade';
import { DIAGNOSTICS_HOSTED_NOTICE } from '../../lib/membership-copy';
import { Switch } from '../ui/switch';
import { cn } from '../../lib/cn';
import { buildActionScope } from './scope-helpers';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';
import { requestContextHeadersForSelection } from '../../lib/selection';

/* ---------- Types ---------- */

type WindowPreset = 'last-hour' | 'last-24h' | 'custom';

interface DiagnosticsExportMeta {
  file_name: string;
  size_bytes: number;
}

interface DiagnosticsExportResponse extends DiagnosticsExportMeta {
  file_path: string;
  manifest: unknown;
}

interface DiagnosticsExportsListResponse {
  exports: Array<DiagnosticsExportMeta & { modified_at: string }>;
}

interface NearestSession {
  id: string;
  started_at: number;
}

type FormMessage =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'empty-window'; nearest: NearestSession[] };

/* ---------- Error-shape helpers ---------- */

/**
 * `empty_window` (404) carries `nearest_sessions` but no sibling `message`
 * field, so `errorMessage()`/`ApiError`'s generic formatting would render
 * the raw code ("empty_window (API 404)") — copy doctrine forbids that, so
 * this is detected and rendered specially (brief: "Nothing recorded in that
 * window." + nearest-session times).
 */
function emptyWindowNearestSessions(err: unknown): NearestSession[] | null {
  if (!(err instanceof ApiError) || err.status !== 404) return null;
  const body = err.body as { error?: unknown; nearest_sessions?: unknown } | undefined;
  if (body?.error !== 'empty_window') return null;
  return Array.isArray(body.nearest_sessions) ? (body.nearest_sessions as NearestSession[]) : [];
}

/**
 * `session_not_found` (404) DOES carry a sibling `message`
 * ("session not found: <id>") — mechanism-flavored, not the required
 * "No session with that ID." copy — so this is also special-cased rather
 * than left to the generic error renderer.
 */
function isSessionNotFound(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 404) return false;
  const body = err.body as { error?: unknown } | undefined;
  return body?.error === 'session_not_found';
}

/**
 * Daemon-issued bearer token, injected into index.html as `window.__MYCO_AUTH__`.
 * Duplicated from `lib/api`'s private accessor rather than imported (same
 * rationale as `attachment-image.tsx`): the download route needs a raw
 * `fetch` (binary body, not JSON), and re-deriving the token here keeps this
 * component free of a dependency several `lib/api`-mocking tests would
 * otherwise have to account for.
 */
function daemonAuthToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const token = (window as unknown as { __MYCO_AUTH__?: string }).__MYCO_AUTH__;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/* ---------- DiagnosticsCard ---------- */

export interface DiagnosticsCardProps {
  /**
   * When true, hide the Surface wrapper — the embedding Settings group
   * card (whose header already reads "Diagnostics") supplies that chrome.
   */
  embedded?: boolean;
}

export function DiagnosticsCard({ embedded = false }: DiagnosticsCardProps = {}) {
  const [preset, setPreset] = useState<WindowPreset>('last-24h');
  const [customSince, setCustomSince] = useState('');
  const [customUntil, setCustomUntil] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [narrative, setNarrative] = useState('');
  const [includeContent, setIncludeContent] = useState(false);
  const [result, setResult] = useState<DiagnosticsExportMeta | null>(null);
  const [message, setMessage] = useState<FormMessage | null>(null);
  const [hostedInfo, setHostedInfo] = useState<HostedDegradedInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const selection = useActiveProjectSelection();
  const groveId = selection?.grove.id ?? null;
  const ctxHeaders = selection ? requestContextHeadersForSelection(selection) : undefined;
  // A diagnostic bundle is always built from THIS machine's local Grove DB
  // (mirrors backup's grove-only scope handling, daemon/api/diagnostics.ts),
  // and all three routes are localhost-only rather than degrade-stamped
  // (host/routing.ts) — so under an attached selection they'd silently
  // build/list the MEMBER's own local display-Grove bundles as if they
  // belonged to the team project. Same suppression BackupCard applies to
  // its list; here the whole card (form + list) is replaced.
  const attached = selection?.project.attached === true;

  const exportsQuery = useQuery({
    queryKey: ['diagnostics-exports', groveId],
    queryFn: () => fetchJson<DiagnosticsExportsListResponse>('/diagnostics/exports', { headers: ctxHeaders }),
    enabled: !!groveId && !attached,
  });
  const exports = exportsQuery.data?.exports ?? [];
  const loaded = !!groveId && (exportsQuery.isSuccess || exportsQuery.isError);
  const listError = exportsQuery.isError ? `Failed to load recent exports: ${errorMessage(exportsQuery.error)}` : null;

  function resolveWindow(): { since: number; until: number } | null {
    const now = Math.floor(Date.now() / 1000);
    if (preset === 'last-hour') return { since: now - SECONDS_PER_HOUR, until: now };
    if (preset === 'last-24h') return { since: now - SECONDS_PER_DAY, until: now };
    if (!customSince || !customUntil) return null;
    const since = Math.floor(new Date(customSince).getTime() / 1000);
    const until = Math.floor(new Date(customUntil).getTime() / 1000);
    if (!Number.isFinite(since) || !Number.isFinite(until)) return null;
    return { since, until };
  }

  async function doExport() {
    const scope = buildActionScope('grove', selection);
    if (!scope) {
      setMessage({ kind: 'error', text: 'Select a project first.' });
      return;
    }
    const trimmedSessionId = sessionId.trim();
    const body: Record<string, unknown> = {
      scope,
      include_content: includeContent,
      narrative: narrative.trim(),
    };
    if (trimmedSessionId) {
      body.session_id = trimmedSessionId;
    } else {
      const timeWindow = resolveWindow();
      if (!timeWindow) {
        setMessage({ kind: 'error', text: 'Pick a start and end time.' });
        return;
      }
      body.window = timeWindow;
    }

    setBusy(true);
    setMessage(null);
    setHostedInfo(null);
    setResult(null);
    try {
      const res = await fetchJson<DiagnosticsExportResponse>('/diagnostics/export', {
        method: 'POST',
        headers: ctxHeaders,
        body: JSON.stringify(body),
      });
      setResult({ file_name: res.file_name, size_bytes: res.size_bytes });
      setMessage({ kind: 'success', text: `Bundle created (${formatBytes(res.size_bytes)})` });
      await exportsQuery.refetch();
    } catch (err) {
      const degraded = hostedDegradedInfo(err);
      if (degraded) {
        setHostedInfo(degraded);
      } else {
        const nearest = emptyWindowNearestSessions(err);
        if (nearest) {
          setMessage({ kind: 'empty-window', nearest });
        } else if (isSessionNotFound(err)) {
          setMessage({ kind: 'error', text: 'No session with that ID.' });
        } else {
          setMessage({ kind: 'error', text: `Export failed: ${errorMessage(err)}` });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function downloadExport(fileName: string) {
    try {
      const headers = new Headers(ctxHeaders);
      const token = daemonAuthToken();
      if (token) headers.set('x-myco-auth', token);
      const res = await fetch(
        withBasePath(`/api/diagnostics/export/${encodeURIComponent(fileName)}/download`),
        { headers },
      );
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage({ kind: 'error', text: `Download failed: ${errorMessage(err)}` });
    }
  }

  const disableWindowControls = sessionId.trim().length > 0;

  const form = (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="diag-window-preset" className="font-sans text-xs font-medium text-on-surface-variant">
            Time window
          </label>
          <select
            id="diag-window-preset"
            value={preset}
            onChange={(e) => setPreset(e.target.value as WindowPreset)}
            disabled={disableWindowControls}
            className="w-full rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-1.5 font-sans text-sm text-on-surface disabled:opacity-50 focus-visible:outline-hidden focus-visible:border-primary/40"
          >
            <option value="last-hour">Last hour</option>
            <option value="last-24h">Last 24 hours</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="diag-session-id" className="font-sans text-xs font-medium text-on-surface-variant">
            Session ID (optional — overrides the time window)
          </label>
          <input
            id="diag-session-id"
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Leave blank to use the time window"
            className="w-full rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-1.5 font-sans text-sm text-on-surface placeholder:text-on-surface-variant/50 focus-visible:outline-hidden focus-visible:border-primary/40"
          />
        </div>
      </div>

      {preset === 'custom' && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="diag-since" className="font-sans text-xs font-medium text-on-surface-variant">
              Since
            </label>
            <input
              id="diag-since"
              type="datetime-local"
              value={customSince}
              onChange={(e) => setCustomSince(e.target.value)}
              disabled={disableWindowControls}
              className="w-full rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-1.5 font-sans text-sm text-on-surface disabled:opacity-50 focus-visible:outline-hidden focus-visible:border-primary/40"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="diag-until" className="font-sans text-xs font-medium text-on-surface-variant">
              Until
            </label>
            <input
              id="diag-until"
              type="datetime-local"
              value={customUntil}
              onChange={(e) => setCustomUntil(e.target.value)}
              disabled={disableWindowControls}
              className="w-full rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-1.5 font-sans text-sm text-on-surface disabled:opacity-50 focus-visible:outline-hidden focus-visible:border-primary/40"
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="diag-narrative" className="font-sans text-xs font-medium text-on-surface-variant">
          Describe what happened (optional — included in the bundle)
        </label>
        <textarea
          id="diag-narrative"
          value={narrative}
          onChange={(e) => setNarrative(e.target.value)}
          rows={3}
          placeholder="What were you doing, and what went wrong?"
          className="w-full rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-2 font-sans text-sm text-on-surface placeholder:text-on-surface-variant/50 focus-visible:outline-hidden focus-visible:border-primary/40"
        />
      </div>

      <div className="flex items-start gap-3 rounded-md bg-surface-container-lowest px-4 py-3">
        <Switch checked={includeContent} onCheckedChange={setIncludeContent} />
        <div className="space-y-0.5">
          <p className="font-sans text-sm text-on-surface">Include full transcript content</p>
          <p className="font-sans text-xs text-on-surface-variant">
            Off by default. When on, the bundle includes your full prompts and responses — only
            enable if you&apos;re comfortable sharing them.
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="default" size="sm" onClick={() => void doExport()} disabled={busy || !groveId}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {busy ? 'Exporting…' : 'Export'}
        </Button>
      </div>
    </div>
  );

  const statusBlock = hostedInfo ? (
    <HostedUnavailable info={hostedInfo} variant="inline" />
  ) : message?.kind === 'empty-window' ? (
    <div className="space-y-1">
      <p className="font-sans text-sm text-tertiary">Nothing recorded in that window.</p>
      {message.nearest.length > 0 && (
        <p className="font-sans text-xs text-on-surface-variant">
          Nearest sessions: {message.nearest.map((s) => formatEpochAbsolute(s.started_at)).join(', ')}
        </p>
      )}
    </div>
  ) : message ? (
    <p className={cn('font-sans text-sm', message.kind === 'success' ? 'text-primary' : 'text-tertiary')}>
      {message.text}
    </p>
  ) : listError ? (
    <p className="font-sans text-sm text-tertiary">{listError}</p>
  ) : null;

  const resultRow = result ? (
    <div className="flex items-center justify-between rounded-md bg-surface-container-lowest px-4 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-mono text-sm text-on-surface truncate">{result.file_name}</span>
        <Badge variant="secondary">{formatBytes(result.size_bytes)}</Badge>
      </div>
      <Button variant="ghost" size="sm" onClick={() => void downloadExport(result.file_name)}>
        <Download className="mr-1.5 h-3.5 w-3.5" />
        Download
      </Button>
    </div>
  ) : null;

  const listBlock =
    exports.length > 0 ? (
      <div className="space-y-2">
        <p className="font-sans text-xs uppercase tracking-widest text-on-surface-variant">Recent exports</p>
        {exports.map((e) => (
          <div
            key={e.file_name}
            className="flex items-center justify-between rounded-md bg-surface-container-lowest px-4 py-2.5"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-mono text-sm text-on-surface truncate">{e.file_name}</span>
              <Badge variant="secondary">{formatBytes(e.size_bytes)}</Badge>
              <span className="font-sans text-xs text-on-surface-variant">
                {new Date(e.modified_at).toLocaleString()}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void downloadExport(e.file_name)}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download
            </Button>
          </div>
        ))}
      </div>
    ) : loaded && !listError ? (
      <p className="font-sans text-sm text-on-surface-variant">No diagnostic bundles exported yet.</p>
    ) : null;

  const body = (
    <>
      <div className="flex items-center gap-3">
        <Bug className="h-4 w-4 text-primary" />
        <SectionHeader>Export diagnostic bundle</SectionHeader>
      </div>

      {attached ? (
        <AccentSurface
          accent="ochre"
          padded
          className="flex items-center gap-2 text-sm text-on-surface-variant"
          role="status"
        >
          <CloudOff className="size-4 shrink-0 text-ochre" aria-hidden />
          <span>{DIAGNOSTICS_HOSTED_NOTICE}</span>
        </AccentSurface>
      ) : (
        <>
          {form}
          {statusBlock}
          {resultRow}
          {listBlock}
        </>
      )}
    </>
  );

  if (embedded) {
    return <div className="space-y-4">{body}</div>;
  }
  return (
    <Surface level="low" className="rounded-lg p-6 space-y-4 transition-all duration-300">
      {body}
    </Surface>
  );
}
