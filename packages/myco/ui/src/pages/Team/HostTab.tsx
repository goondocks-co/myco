import { useState } from 'react';
import { Server, Link2, AlertTriangle, Activity } from 'lucide-react';
import { Panel } from '../../components/ui/panel';
import { IconEyebrow } from '../../components/ui/icon-eyebrow';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { AccentSurface } from '../../components/ui/accent-surface';
import { cn } from '../../lib/cn';
import { useGroves } from '../../hooks/use-groves';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';
import {
  useHostMembershipStatus,
  useJoinHost,
  useLeaveHost,
  useAttachProject,
  useDetachProject,
  useDrainHealth,
  type HostMembershipHost,
  type HostMembershipHint,
  type HostMembershipProjectRef,
  type DrainCounters,
} from '../../hooks/use-host-membership';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const inputClass =
  'rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40';
const labelClass = 'myco-eyebrow-sm text-on-surface-variant';

// ---------------------------------------------------------------------------
// Affiliation hint (host/hint.ts's "run myco join" guidance, as a UI CTA)
// ---------------------------------------------------------------------------

function AffiliationHintBanner({ hint }: { hint: HostMembershipHint }) {
  return (
    <AccentSurface accent="ochre" padded className="flex items-start gap-3" role="status">
      <AlertTriangle className="size-5 shrink-0 text-ochre" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm font-medium text-on-surface">This project is affiliated with a Team Host</p>
        <p className="m-0 text-sm text-on-surface-variant">{hint.message}</p>
      </div>
    </AccentSurface>
  );
}

// ---------------------------------------------------------------------------
// Join form — host id + key + server URL + overlay address (the stable
// member-side wire contract). Advanced overrides (hostname, manual-bridge
// bearer, protocol version, label) stay CLI-only.
// ---------------------------------------------------------------------------

function JoinHostForm() {
  const join = useJoinHost();
  const [hostRef, setHostRef] = useState('');
  const [key, setKey] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [overlayAddress, setOverlayAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const canSubmit = Boolean(hostRef.trim() && key.trim() && serverUrl.trim() && overlayAddress.trim()) && !join.isPending;

  const handleJoin = async () => {
    setError(null);
    setSuccess(null);
    try {
      const result = await join.mutateAsync({
        host_ref: hostRef.trim(),
        key: key.trim(),
        server_url: serverUrl.trim(),
        overlay_address: overlayAddress.trim(),
      });
      setSuccess(`${result.created ? 'Joined' : 'Re-joined'} ${result.host_id}${result.host_reachable ? '.' : ' — not confirmed reachable yet.'}`);
      // One-time key: never leave it sitting in a form field after use.
      setKey('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Panel tone="sage" eyebrow={<IconEyebrow Icon={Server}>Team Host</IconEyebrow>} title="Join a Team Host">
      <p className="text-xs text-on-surface-variant m-0 mb-3">
        Enroll this machine with a Team Host using the one-time key and overlay address a host operator shared
        with you. The host id is used exactly as typed — Myco can't verify it until the join completes.
      </p>
      <div className="flex flex-col gap-2 mb-3">
        <label className={labelClass} htmlFor="host-join-id">Host id</label>
        <input id="host-join-id" className={inputClass} value={hostRef} onChange={(e) => setHostRef(e.target.value)} placeholder="host_…" />
        <label className={labelClass} htmlFor="host-join-key">One-time key</label>
        <input id="host-join-key" type="password" className={inputClass} value={key} onChange={(e) => setKey(e.target.value)} />
        <label className={labelClass} htmlFor="host-join-server-url">Server URL</label>
        <input id="host-join-server-url" className={inputClass} value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://headscale.example.com" />
        <label className={labelClass} htmlFor="host-join-overlay-address">Overlay address</label>
        <input id="host-join-overlay-address" className={inputClass} value={overlayAddress} onChange={(e) => setOverlayAddress(e.target.value)} placeholder="100.64.x.y:port" />
        <div className="flex justify-end">
          <Button size="sm" disabled={!canSubmit} onClick={handleJoin}>
            {join.isPending ? 'Joining…' : 'Join host'}
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-terracotta m-0" data-testid="host-join-error">{error}</p>}
      {success && <p className="text-sm text-sage m-0" data-testid="host-join-success">{success}</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Drain health — Task C-5's status API, first UI consumer.
// ---------------------------------------------------------------------------

function DrainCell({ label, counters }: { label: string; counters: DrainCounters | undefined }) {
  if (!counters) return null;
  const failing = counters.failing_entries > 0;
  const sized = counters.pending_bytes ?? counters.pending_records;
  return (
    <div className={cn('flex flex-col gap-0.5 rounded px-2 py-1', failing ? 'bg-terracotta/10' : 'bg-surface-container')}>
      <span className="myco-eyebrow-sm text-on-surface-variant">{label}</span>
      <span className="text-xs text-on-surface">
        {counters.pending_entries} pending{sized !== undefined ? ` (${sized})` : ''}
        {failing ? ` · ${counters.failing_entries} failing` : ''}
      </span>
    </div>
  );
}

function DrainHealthPanel() {
  const { data, isLoading } = useDrainHealth();
  const hosts = data?.hosts ?? [];
  return (
    <Panel tone="sage" eyebrow={<IconEyebrow Icon={Activity}>Drain health</IconEyebrow>} title="Capture delivery">
      {isLoading && hosts.length === 0 ? (
        <p className="text-sm text-on-surface-variant m-0">Loading…</p>
      ) : hosts.length === 0 ? (
        <p className="text-sm text-on-surface-variant m-0">Nothing to report yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {hosts.map((h) => (
            <div key={h.host_id} className="rounded-md border border-[var(--ghost-border)] px-3 py-2">
              <span className="text-xs font-medium text-on-surface">{h.label}</span>
              <div className="grid grid-cols-3 gap-2 mt-1">
                <DrainCell label="Transcript" counters={h.drains.transcript} />
                <DrainCell label="Plan" counters={h.drains.plan} />
                <DrainCell label="Live events" counters={h.drains.event_replay} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Joined hosts — per-project attach refs, leave/detach.
// ---------------------------------------------------------------------------

function ProjectRefRow({ hostId, ref: projectRef }: { hostId: string; ref: HostMembershipProjectRef }) {
  const detach = useDetachProject();
  const [error, setError] = useState<string | null>(null);

  const handleDetach = async () => {
    if (!projectRef.root) return;
    setError(null);
    try {
      await detach.mutateAsync({ project_root: projectRef.root, project_id: projectRef.project_id });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 rounded bg-surface-container px-2 py-1">
        <span className="text-xs font-mono text-on-surface-variant truncate" title={projectRef.root ?? undefined}>
          {projectRef.project_id}
        </span>
        <button
          type="button"
          disabled={detach.isPending || !projectRef.root}
          onClick={handleDetach}
          className="text-xs text-on-surface-variant hover:text-terracotta-text transition-colors disabled:opacity-50 shrink-0"
          aria-label={`Detach ${projectRef.project_id} from host ${hostId}`}
        >
          {detach.isPending ? 'Detaching…' : 'Detach'}
        </button>
      </div>
      {error && <p className="text-xs text-terracotta m-0">{error}</p>}
    </div>
  );
}

function HostCard({ host }: { host: HostMembershipHost }) {
  const leave = useLeaveHost();
  const [error, setError] = useState<string | null>(null);

  const handleLeave = async () => {
    const message = host.projects.length > 0
      ? `Leave "${host.label}"? This detaches ${host.projects.length} attached project${host.projects.length === 1 ? '' : 's'} (they resolve to a local Grove again) and removes this host's overlay connection.`
      : `Leave "${host.label}"? This removes this host's overlay connection from this machine.`;
    if (!window.confirm(message)) return;
    setError(null);
    try {
      await leave.mutateAsync(host.host_id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--ghost-border)] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-on-surface">{host.label}</span>
          <div className="text-xs font-mono text-on-surface-variant break-all">{host.host_id}</div>
          <div className="text-xs text-on-surface-variant">
            {host.overlay_address}{host.proxy_port !== null ? ` · local proxy 127.0.0.1:${host.proxy_port}` : ''}
          </div>
        </div>
        <Badge variant="outline">{host.projects.length} project{host.projects.length === 1 ? '' : 's'}</Badge>
      </div>
      {host.projects.length > 0 && (
        <div className="flex flex-col gap-1">
          {host.projects.map((ref) => (
            <ProjectRefRow key={ref.project_id} hostId={host.host_id} ref={ref} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        {error && <p className="text-xs text-terracotta m-0">{error}</p>}
        <button
          type="button"
          disabled={leave.isPending}
          onClick={handleLeave}
          className="ml-auto text-xs text-on-surface-variant hover:text-terracotta-text transition-colors disabled:opacity-50"
        >
          {leave.isPending ? 'Leaving…' : 'Leave host'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attach a local project — the host's Grove id is operator-typed, honestly
// unverified (no local source knows a host's Grove list; WS5/E-0 territory).
// ---------------------------------------------------------------------------

function AttachProjectPanel({ hosts }: { hosts: HostMembershipHost[] }) {
  const groves = useGroves();
  const attach = useAttachProject();
  const [projectRoot, setProjectRoot] = useState('');
  const [hostId, setHostId] = useState('');
  const [groveId, setGroveId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (hosts.length === 0) return null;

  const attachedProjectIds = new Set(hosts.flatMap((h) => h.projects.map((p) => p.project_id)));
  const localProjects = (groves.data?.groves ?? []).flatMap((g) =>
    g.projects
      .filter((p) => !attachedProjectIds.has(p.project_id))
      .map((p) => ({ projectId: p.project_id, root: p.root, label: `${p.name} (${g.name})` })),
  );

  const canSubmit = Boolean(projectRoot.trim() && hostId.trim() && groveId.trim()) && !attach.isPending;

  const handleAttach = async () => {
    setError(null);
    setSuccess(null);
    try {
      const result = await attach.mutateAsync({
        project_root: projectRoot.trim(),
        host_id: hostId.trim(),
        grove_id: groveId.trim(),
      });
      setSuccess(result.already_attached
        ? `${result.project_id} is already attached to ${result.host_label} — converged.`
        : `Attached ${result.project_id} to ${result.host_label}.`);
      setProjectRoot('');
      setGroveId('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Panel tone="sage" eyebrow={<IconEyebrow Icon={Link2}>Attach</IconEyebrow>} title="Route a project through a Team Host">
      <p className="text-xs text-on-surface-variant m-0 mb-3">
        Attach a local project so future requests route to the host's Grove instead. The Grove id below isn't
        verified here — get it from the host operator or the host's Groves page.
      </p>
      {localProjects.length === 0 ? (
        <p className="text-sm text-on-surface-variant m-0">
          No local projects available to attach — every registered project is already attached, or none are registered yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="host-attach-project">Project</label>
          <select id="host-attach-project" className={inputClass} value={projectRoot} onChange={(e) => setProjectRoot(e.target.value)}>
            <option value="">Select a local project…</option>
            {localProjects.map((p) => <option key={p.projectId} value={p.root}>{p.label}</option>)}
          </select>
          <label className={labelClass} htmlFor="host-attach-host">Host</label>
          <select id="host-attach-host" className={inputClass} value={hostId} onChange={(e) => setHostId(e.target.value)}>
            <option value="">Select a joined host…</option>
            {hosts.map((h) => <option key={h.host_id} value={h.host_id}>{h.label} ({h.host_id})</option>)}
          </select>
          <label className={labelClass} htmlFor="host-attach-grove">Grove id (on the host)</label>
          <input id="host-attach-grove" className={inputClass} value={groveId} onChange={(e) => setGroveId(e.target.value)} placeholder="grove_…" />
          <div className="flex justify-end">
            <Button size="sm" disabled={!canSubmit} onClick={handleAttach}>
              {attach.isPending ? 'Attaching…' : 'Attach project'}
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-terracotta m-0 mt-2" data-testid="host-attach-error">{error}</p>}
      {success && <p className="text-sm text-sage m-0 mt-2" data-testid="host-attach-success">{success}</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Top-level tab — Team Host membership. Always renders (no legacy-team gate):
// this IS the primary story now (Chris's PR #667 review direction).
// ---------------------------------------------------------------------------

export function HostTab() {
  const selection = useActiveProjectSelection();
  const status = useHostMembershipStatus(selection?.project.root);
  const hosts = status.data?.hosts ?? [];

  return (
    <div className="flex flex-col gap-4">
      {status.data?.hint && <AffiliationHintBanner hint={status.data.hint} />}
      <JoinHostForm />
      {hosts.length > 0 && (
        <Panel
          tone="sage"
          eyebrow={<IconEyebrow Icon={Server}>Joined hosts</IconEyebrow>}
          title={`${hosts.length} host${hosts.length === 1 ? '' : 's'}`}
        >
          <div className="flex flex-col gap-2">
            {hosts.map((h) => <HostCard key={h.host_id} host={h} />)}
          </div>
        </Panel>
      )}
      <AttachProjectPanel hosts={hosts} />
      {hosts.length > 0 && <DrainHealthPanel />}
    </div>
  );
}

export default HostTab;
