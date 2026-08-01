import { useMemo, useState } from 'react';
import { Server, Link2, AlertTriangle, Activity, Loader2 } from 'lucide-react';
import { Panel } from '../../components/ui/panel';
import { IconEyebrow } from '../../components/ui/icon-eyebrow';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { AccentSurface } from '../../components/ui/accent-surface';
import { SlideoutDetailPanel } from '../../components/ui/slideout-detail-panel';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { DrainCell } from '../../components/team/DrainCell';
import { LeaveHostControl } from '../../components/team/LeaveHostControl';
import { HostDetailPanel } from '../../components/team/HostDetailPanel';
import {
  ATTACH_CONFIRM_COPY,
  ATTACH_CONFIRM_LABEL,
  ATTACH_CONFIRM_TITLE,
  ATTACH_MISMATCH_WARNING_COPY,
  CANCEL_MOVE_CONFIRM_COPY,
  DETACH_CONFIRM_COPY,
  DETACH_CONFIRM_LABEL,
  DETACH_CONFIRM_TITLE,
  DETACH_NO_PULL_CONFIRM_COPY,
  DETACH_NO_PULL_CONFIRM_LABEL,
  LOCAL_GROVE_PICKER_HELPER,
  LOCAL_GROVE_PICKER_LABEL,
  RESIDENCY_STALLED_COPY,
  membershipErrorCode,
  membershipErrorCopy,
  reachabilityHintSuffix,
  residencyAbortTooLateCopy,
  residencyPendingDetail,
  residencyPhaseLabel,
  residencyProgressHeadline,
} from '../../lib/membership-copy';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';
import { useGroves } from '../../hooks/use-groves';
import { TeamSettingsPanel } from '../../components/team/TeamSettingsPanel';
import type { TeamConfigTarget } from '../../hooks/use-scoped-config';
import {
  useHostMembershipStatus,
  useJoinHost,
  useAttachProject,
  useDetachProject,
  useDrainHealth,
  useHostMembershipHealth,
  useResidencyStatus,
  useResidencyAbort,
  type HostMembershipHost,
  type HostMembershipHint,
  type HostMembershipProjectRef,
  type ResidencyStatus, ABORTABLE_RESIDENCY_PHASES } from '../../hooks/use-host-membership';

const inputClass =
  'rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40';
const labelClass = 'myco-eyebrow-sm text-on-surface-variant';

// ---------------------------------------------------------------------------
// Affiliation hint — host/hint.ts's `state` + `host_id` re-voiced for the UI.
// `hint.message` is the CLI-voiced wire string (backticked `myco` commands);
// that stays put for CLI/doctor consumers, but never renders in the browser.
// ---------------------------------------------------------------------------

function affiliationHintCopy(hint: HostMembershipHint): string {
  switch (hint.state) {
    case 'not_joined':
      return `This project is affiliated with host ${hint.host_id} — join it using the form below to route the project there.`;
    case 'not_attached':
      return `This machine is joined to ${hint.host_id} — attach this project using the panel below.`;
  }
}

function AffiliationHintBanner({ hint }: { hint: HostMembershipHint }) {
  return (
    <AccentSurface accent="ochre" padded className="flex items-start gap-3" role="status">
      <AlertTriangle className="size-5 shrink-0 text-ochre" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm font-medium text-on-surface">This project is affiliated with a Team Host</p>
        <p className="m-0 text-sm text-on-surface-variant">{affiliationHintCopy(hint)}</p>
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
  const status = useHostMembershipStatus();
  // Absent on an older daemon — treat as capable so the form is never disabled
  // by a missing field rather than a real limitation.
  const overlaySupported = status.data?.overlay_supported !== false;
  const [hostRef, setHostRef] = useState('');
  const [key, setKey] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [overlayAddress, setOverlayAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const canSubmit = overlaySupported
    && Boolean(hostRef.trim() && key.trim() && serverUrl.trim() && overlayAddress.trim())
    && !join.isPending;

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
      setError(membershipErrorCopy(err));
    }
  };

  return (
    <Panel tone="sage" eyebrow={<IconEyebrow Icon={Server}>Team Host</IconEyebrow>} title="Join a Team Host">
      <p className="text-xs text-on-surface-variant m-0 mb-3">
        Enroll this machine with a Team Host using the one-time key and overlay address a host operator shared
        with you. The host id is used exactly as typed — Myco can't verify it until the join completes.
      </p>
      {!overlaySupported && (
        <p className="text-xs text-terracotta-text m-0 mb-3">
          This machine can't join a team yet — Myco's overlay client has no build for this operating system.
          Everything else in Myco works normally here. Ask your host operator not to spend a one-time key on
          this machine.
        </p>
      )}
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
// Drain health — Task C-5's status API, first UI consumer. `DrainCell` lives
// in components/team/ (shared with the host detail slideout's per-host
// breakdown, Task T5 — same `useDrainHealth()` poll, no second fetch).
// ---------------------------------------------------------------------------

function DrainHealthPanel() {
  const { data, isLoading } = useDrainHealth();
  const hosts = data?.hosts ?? [];
  return (
    <Panel tone="sage" eyebrow={<IconEyebrow Icon={Activity}>Capture delivery</IconEyebrow>} title="Capture delivery">
      {isLoading && hosts.length === 0 ? (
        <p className="text-sm text-on-surface-variant m-0">Loading…</p>
      ) : hosts.length === 0 ? (
        <p className="text-sm text-on-surface-variant m-0">Nothing to report yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {hosts.map((h) => (
            <div key={h.host_id} className="rounded-md border border-[var(--ghost-border)] px-3 py-2">
              <span className="text-xs font-medium text-on-surface">{h.label}</span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
                <DrainCell label="Transcript" counters={h.drains.transcript} />
                <DrainCell label="Plan" counters={h.drains.plan} />
                <DrainCell label="Live events" counters={h.drains.event_replay} />
                <DrainCell label="Residency" counters={h.drains.residency} />
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

// Compact in-flight progress for a residency round trip. Direction-aware
// headline, a friendly phase step, a subdued pending count, a quiet warning
// when the last drain attempt erred, and a Cancel-move control (confirm →
// residency-abort). Cancel-move and the cancel-oriented warning drop out once
// the transition passes the point of no return (detach `applying`/`rehoming`):
// the backend refuses abort there, so offering it would only dead-end. This
// renders both inside the transitioning project's row AND, once a detach has
// dropped that row, standalone in the same host card (see HostCard).
function ResidencyProgress({ status, projectId }: { status: ResidencyStatus; projectId: string }) {
  const abort = useResidencyAbort();
  const [error, setError] = useState<string | null>(null);
  const phase = residencyPhaseLabel(status.phase);
  const pending = residencyPendingDetail(status.rows_pending);
  // Past the flip (the member ref is already gone) abort is refused; don't
  // offer it. Keyed on phase so it holds whether the row is present or not.
  // Cancel exists only for the phases the daemon's abort route accepts — an
  // ALLOWLIST, so a future phase defaults to not-cancelable here too.
  const cancelable = status.phase !== undefined && ABORTABLE_RESIDENCY_PHASES.has(status.phase);

  const handleCancel = async () => {
    if (!window.confirm(CANCEL_MOVE_CONFIRM_COPY)) return;
    setError(null);
    try {
      await abort.mutateAsync({ project_id: projectId });
    } catch (err) {
      // The move can pass the point of no return between the poll and the
      // click; name the direction-appropriate recovery rather than the raw code.
      setError(
        membershipErrorCode(err) === 'residency_abort_too_late'
          ? residencyAbortTooLateCopy(status.direction)
          : membershipErrorCopy(err),
      );
    }
  };

  return (
    <div
      className="flex flex-col gap-1 rounded bg-surface-container px-2 py-1.5"
      role="status"
      data-testid={`residency-progress-${projectId}`}
    >
      <div className="flex items-center gap-2">
        <Loader2 className="size-3 shrink-0 animate-spin text-sage" aria-hidden />
        <span className="text-xs text-on-surface">{residencyProgressHeadline(status.direction)}</span>
        {phase && <span className="text-xs text-on-surface-variant">· {phase}</span>}
        {cancelable && (
          <button
            type="button"
            disabled={abort.isPending}
            onClick={handleCancel}
            className="ml-auto text-xs text-on-surface-variant hover:text-terracotta-text transition-colors disabled:opacity-50 shrink-0"
          >
            {abort.isPending ? 'Cancelling…' : 'Cancel move'}
          </button>
        )}
      </div>
      {pending && <span className="text-xs text-on-surface-variant">{pending}</span>}
      {cancelable && status.last_error && (
        <span className="flex items-center gap-1 text-xs text-ochre" title={status.last_error}>
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          {RESIDENCY_STALLED_COPY}
        </span>
      )}
      {cancelable && error && <p className="text-xs text-terracotta m-0">{error}</p>}
    </div>
  );
}

function ProjectRefRow({
  hostId,
  projectRef,
  status,
  transitionInFlight,
  onTransitionStart,
}: {
  hostId: string;
  projectRef: HostMembershipProjectRef;
  /** Live residency status, present only when THIS project is the one being
   *  transitioned; `undefined` for every other row. */
  status: ResidencyStatus | undefined;
  /** A transition (this project's or another's) is in flight — detach is held
   *  off everywhere while one runs (the backend also refuses). */
  transitionInFlight: boolean;
  onTransitionStart: (projectId: string, hostId: string) => void;
}) {
  const detach = useDetachProject();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Second-stage detach: set when the host refused with
  // `residency_pull_unavailable`; the next confirm retries with allow_no_pull.
  const [noPullConfirm, setNoPullConfirm] = useState(false);

  const runDetach = async (allowNoPull: boolean) => {
    if (!projectRef.root) return;
    setError(null);
    try {
      await detach.mutateAsync({
        project_root: projectRef.root,
        project_id: projectRef.project_id,
        ...(allowNoPull ? { allow_no_pull: true } : {}),
      });
      setConfirmOpen(false);
      setNoPullConfirm(false);
      onTransitionStart(projectRef.project_id, hostId);
    } catch (err) {
      // Host too old to return data: keep the dialog open and offer the
      // explicit "disconnect anyway" fallback instead of a dead-end error.
      if (!allowNoPull && membershipErrorCode(err) === 'residency_pull_unavailable') {
        setNoPullConfirm(true);
        setError(null);
      } else {
        setError(membershipErrorCopy(err));
      }
    }
  };

  const showProgress = status?.in_flight === true;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 rounded bg-surface-container px-2 py-1">
        <span className="text-xs font-mono text-on-surface-variant truncate" title={projectRef.root ?? undefined}>
          {projectRef.project_id}
        </span>
        <button
          type="button"
          disabled={detach.isPending || !projectRef.root || transitionInFlight}
          onClick={() => { setNoPullConfirm(false); setError(null); setConfirmOpen(true); }}
          className="text-xs text-on-surface-variant hover:text-terracotta-text transition-colors disabled:opacity-50 shrink-0"
          aria-label={`Detach ${projectRef.project_id} from host ${hostId}`}
        >
          {detach.isPending ? 'Detaching…' : 'Detach'}
        </button>
      </div>
      {projectRef.mismatch === 'attach_grove_mismatch' && (
        <p
          className="flex items-center gap-1 text-xs text-ochre m-0"
          role="status"
          data-testid={`project-ref-mismatch-${projectRef.project_id}`}
        >
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          {ATTACH_MISMATCH_WARNING_COPY}
        </p>
      )}
      {showProgress && status && <ResidencyProgress status={status} projectId={projectRef.project_id} />}
      {error && !confirmOpen && <p className="text-xs text-terracotta m-0">{error}</p>}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => { setConfirmOpen(open); if (!open) { setNoPullConfirm(false); setError(null); } }}
        title={DETACH_CONFIRM_TITLE}
        description={noPullConfirm ? DETACH_NO_PULL_CONFIRM_COPY : DETACH_CONFIRM_COPY}
        icon={<AlertTriangle className="h-4 w-4 text-tertiary" />}
        meta={[{ label: 'Project', value: projectRef.project_id }]}
        confirmLabel={noPullConfirm ? DETACH_NO_PULL_CONFIRM_LABEL : DETACH_CONFIRM_LABEL}
        onConfirm={() => runDetach(noPullConfirm)}
        isPending={detach.isPending}
        errorMessage={error}
      />
    </div>
  );
}

function HostCard({
  host,
  onSelect,
  transition,
  residencyStatus,
  transitionInFlight,
  onTransitionStart,
}: {
  host: HostMembershipHost;
  onSelect: () => void;
  /** The project + host currently being transitioned, if any. */
  transition: { projectId: string; hostId: string } | null;
  residencyStatus: ResidencyStatus | undefined;
  transitionInFlight: boolean;
  onTransitionStart: (projectId: string, hostId: string) => void;
}) {
  const watchingThisHost = transition?.hostId === host.host_id;
  const hasWatchedRef = host.projects.some((p) => p.project_id === transition?.projectId);
  // A detach drops the member ref at the pulling→applying flip while the
  // transition keeps restoring (T4). Keep the progress visible standalone in
  // this card once the row is gone, so the user doesn't read the disappearance
  // as "done" or "broke". Only detach loses its ref; attach keeps it.
  const showOrphanedProgress =
    watchingThisHost
    && !hasWatchedRef
    && residencyStatus?.in_flight === true
    && residencyStatus.direction === 'detach'
    && transition !== null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--ghost-border)] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        {/* A real button (not a div onClick) so the card-select affordance
            stays keyboard-reachable; the Detach/Leave controls below are
            siblings, never nested inside it, so clicking them can't also
            trigger selection. */}
        <button type="button" onClick={onSelect} className="min-w-0 text-left" aria-label={`View ${host.label} details`}>
          <span className="text-sm font-medium text-on-surface">{host.label}</span>
          <div className="text-xs font-mono text-on-surface-variant break-all">{host.host_id}</div>
          <div className="text-xs text-on-surface-variant">
            {host.overlay_address}{host.proxy_port !== null ? ` · local proxy 127.0.0.1:${host.proxy_port}` : ''}
          </div>
        </button>
        <Badge variant="outline">{host.projects.length} project{host.projects.length === 1 ? '' : 's'}</Badge>
      </div>
      {(host.projects.length > 0 || showOrphanedProgress) && (
        <div className="flex flex-col gap-1">
          {host.projects.map((ref) => (
            <ProjectRefRow
              key={ref.project_id}
              hostId={host.host_id}
              projectRef={ref}
              status={ref.project_id === transition?.projectId ? residencyStatus : undefined}
              transitionInFlight={transitionInFlight}
              onTransitionStart={onTransitionStart}
            />
          ))}
          {showOrphanedProgress && transition && residencyStatus && (
            <ResidencyProgress status={residencyStatus} projectId={transition.projectId} />
          )}
        </div>
      )}
      <LeaveHostControl host={host} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attach a project — the operator types the checkout path directly, exactly
// like `myco attach <project>` (same "typed, honestly unverified" posture as
// the join form's host id). A checkout with existing local history is NOT
// refused: attaching migrates that history to the host (Phase F, D-F-1), while
// a fresh checkout simply starts flowing from now on. There is no picker for
// the HOST's served Grove — a host serves exactly one designated Grove and
// self-reports it at join, so attach sources it from the joined host record and
// the operator never supplies one.
//
// The "Show under" picker below IS built from `/api/groves` — a DIFFERENT Grove
// concept (E-4 local-view requirement, decision-ef693c71 D1): the member's OWN
// local Grove the newly-attached project displays under in this machine's UI,
// sent as `local_grove_id`.
// ---------------------------------------------------------------------------

function AttachProjectPanel({
  hosts,
  transitionInFlight,
  onTransitionStart,
}: {
  hosts: HostMembershipHost[];
  transitionInFlight: boolean;
  onTransitionStart: (projectId: string, hostId: string) => void;
}) {
  const attach = useAttachProject();
  const groves = useGroves();
  // Cache-only read (`enabled: false`) — this panel never triggers its own
  // reachability probe (decision-ef693c71 D3); it only annotates the host
  // select with whatever the detail slideout's health query already fetched.
  const health = useHostMembershipHealth(false);
  const [projectRoot, setProjectRoot] = useState('');
  const [hostId, setHostId] = useState('');
  const [localGroveId, setLocalGroveId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (hosts.length === 0) return null;

  const localGroves = groves.data?.groves ?? [];
  const defaultGroveId = localGroves.find((g) => g.is_default)?.id ?? '';
  const effectiveLocalGroveId = localGroveId || defaultGroveId;

  const canSubmit = Boolean(projectRoot.trim() && hostId.trim()) && !attach.isPending && !transitionInFlight;

  const handleAttach = async () => {
    setError(null);
    setSuccess(null);
    try {
      const result = await attach.mutateAsync({
        project_root: projectRoot.trim(),
        host_id: hostId.trim(),
        ...(effectiveLocalGroveId ? { local_grove_id: effectiveLocalGroveId } : {}),
      });
      setSuccess(result.already_attached
        ? `${result.project_id} is already attached to ${result.host_label}.`
        : `Project attached — new work now routes to ${result.host_label}.`);
      setProjectRoot('');
      setLocalGroveId('');
      setConfirmOpen(false);
      onTransitionStart(result.project_id, result.host_id);
    } catch (err) {
      // Keep the dialog open so the failure shows next to the Confirm button.
      setError(membershipErrorCopy(err));
    }
  };

  return (
    <Panel tone="sage" eyebrow={<IconEyebrow Icon={Link2}>Attach</IconEyebrow>} title="Route a project through a Team Host">
      <p className="text-xs text-on-surface-variant m-0 mb-3">
        Connect a checkout to the team. A project with local history moves that history to the team host
        (Myco saves a local backup first); a fresh checkout simply starts flowing from now on. The path below
        isn't verified here. The host's team storage is used automatically — nothing to supply for it.
      </p>
      <div className="flex flex-col gap-2">
        <label className={labelClass} htmlFor="host-attach-project">Project path</label>
        <input id="host-attach-project" className={inputClass} value={projectRoot} onChange={(e) => setProjectRoot(e.target.value)} placeholder="/path/to/checkout" />
        <label className={labelClass} htmlFor="host-attach-host">Host</label>
        <select id="host-attach-host" className={inputClass} value={hostId} onChange={(e) => setHostId(e.target.value)}>
          <option value="">Select a joined host…</option>
          {hosts.map((h) => {
            const cached = health.data?.hosts.find((entry) => entry.host_id === h.host_id);
            return (
              <option key={h.host_id} value={h.host_id}>
                {h.label} ({h.host_id}){reachabilityHintSuffix(cached?.reachable)}
              </option>
            );
          })}
        </select>
        {localGroves.length > 0 && (
          <>
            <label className={labelClass} htmlFor="host-attach-local-grove">{LOCAL_GROVE_PICKER_LABEL}</label>
            <select
              id="host-attach-local-grove"
              className={inputClass}
              value={effectiveLocalGroveId}
              onChange={(e) => setLocalGroveId(e.target.value)}
            >
              {localGroves.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <p className="text-xs text-on-surface-variant m-0">{LOCAL_GROVE_PICKER_HELPER}</p>
          </>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => { setError(null); setSuccess(null); setConfirmOpen(true); }}
          >
            {attach.isPending ? 'Attaching…' : 'Attach project'}
          </Button>
        </div>
      </div>
      {error && !confirmOpen && <p className="text-sm text-terracotta m-0 mt-2" data-testid="host-attach-error">{error}</p>}
      {success && <p className="text-sm text-sage m-0 mt-2" data-testid="host-attach-success">{success}</p>}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => { setConfirmOpen(open); if (!open) setError(null); }}
        title={ATTACH_CONFIRM_TITLE}
        description={ATTACH_CONFIRM_COPY}
        icon={<Link2 className="h-4 w-4 text-tertiary" />}
        confirmLabel={ATTACH_CONFIRM_LABEL}
        onConfirm={handleAttach}
        isPending={attach.isPending}
        errorMessage={error}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Team settings — per-host selection (spec §6). Previously HostTab listed
// hosts with no notion of "which host am I configuring." "This machine" is
// always offered first (this box may itself be a Team Host); each joined
// host with at least one attached project is offered too, using that host's
// FIRST attach ref purely as the wire carrier that routes a team-write
// request to it (`classifyRoute` resolves the destination host from the
// carrier project's attach ref — there is no per-request host header). The
// value edited is grove-wide, not project-specific, so which attached
// project carries the request makes no functional difference — PROVIDED the
// carrier itself still resolves. A ref flagged `mismatch` 404s the whole
// panel (its attach record points at a Grove the host no longer serves), so
// the carrier prefers the first non-mismatched ref and only falls back to
// `projects[0]` when every ref on the host is flagged. A joined host with no
// attached project yet has no carrier available and is left out — attach a
// project to it first.
// ---------------------------------------------------------------------------

const SELF_TEAM_TARGET_ID = 'self';

interface TeamSettingsOption {
  id: string;
  label: string;
  target: TeamConfigTarget;
}

function teamSettingsOptions(hosts: HostMembershipHost[]): TeamSettingsOption[] {
  const options: TeamSettingsOption[] = [
    { id: SELF_TEAM_TARGET_ID, label: 'This machine', target: { carrier: null } },
  ];
  for (const host of hosts) {
    const ref = host.projects.find((p) => p.mismatch !== 'attach_grove_mismatch') ?? host.projects[0];
    if (!ref) continue;
    options.push({
      // Distinct from the plain host label used elsewhere on this page
      // (e.g. HostCard) so the two never collide as exact-text matches.
      id: host.host_id,
      label: `${host.label} (${host.host_id})`,
      target: { carrier: { groveId: ref.grove_id, projectId: ref.project_id } },
    });
  }
  return options;
}

function TeamSettingsSection({ hosts }: { hosts: HostMembershipHost[] }) {
  const options = useMemo(() => teamSettingsOptions(hosts), [hosts]);
  const [selectedId, setSelectedId] = useState(SELF_TEAM_TARGET_ID);
  const selected = options.find((o) => o.id === selectedId) ?? options[0]!;

  return (
    <div className="flex flex-col gap-3">
      {options.length > 1 && (
        <div className="flex items-center gap-2">
          <label className={labelClass} htmlFor="team-settings-host">Configure team for</label>
          <select
            id="team-settings-host"
            className={inputClass}
            value={selected.id}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
      {/* Remount on target change — the reused forms hold local draft state
          keyed to whatever grove they last loaded; a fresh mount avoids a
          stale draft bleeding across hosts. */}
      <TeamSettingsPanel key={selected.id} target={selected.target} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level tab — Team Host membership. Always renders (no legacy-team gate):
// this IS the primary story now (Chris's PR #667 review direction).
// ---------------------------------------------------------------------------

export function HostTab() {
  const selection = useActiveProjectSelection();
  const status = useHostMembershipStatus(selection?.project.root ?? undefined);
  const hosts = status.data?.hosts ?? [];
  // Page-wide selected host (precedent: Logs.tsx's selectedEntry) — ADDITIVE:
  // the host list, DrainHealthPanel, and AttachProjectPanel keep rendering
  // ALL hosts exactly as before. Selection only opens the detail slideout.
  // Deriving `selectedHost` from the live `hosts` array (rather than storing
  // the whole host object) means a status refresh that drops the host (e.g.
  // it was left from another surface) auto-closes the slideout for free.
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const selectedHost = hosts.find((h) => h.host_id === selectedHostId) ?? null;

  // The project (and its host) whose residency round trip we're actively
  // watching. Set when an attach/detach mutation resolves; the status poll
  // (keyed by project id, not the ref) self-disarms once the transition
  // finishes. The host id lets the progress line stay put in that host's card
  // even after a detach drops the member ref mid-transition. Only one runs at
  // a time — the backend enforces it.
  const [transition, setTransition] = useState<{ projectId: string; hostId: string } | null>(null);
  const onTransitionStart = (projectId: string, hostId: string) => setTransition({ projectId, hostId });
  const residency = useResidencyStatus(transition?.projectId, transition !== null);
  const residencyStatus = residency.data;
  const transitionInFlight = residencyStatus?.in_flight === true;

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
            {hosts.map((h) => (
              <HostCard
                key={h.host_id}
                host={h}
                onSelect={() => setSelectedHostId(h.host_id)}
                transition={transition}
                residencyStatus={residencyStatus}
                transitionInFlight={transitionInFlight}
                onTransitionStart={onTransitionStart}
              />
            ))}
          </div>
        </Panel>
      )}
      <AttachProjectPanel
        hosts={hosts}
        transitionInFlight={transitionInFlight}
        onTransitionStart={onTransitionStart}
      />
      {hosts.length > 0 && <DrainHealthPanel />}
      <TeamSettingsSection hosts={hosts} />
      <SlideoutDetailPanel
        open={selectedHost !== null}
        onClose={() => setSelectedHostId(null)}
        ariaLabel={selectedHost ? `${selectedHost.label} details` : 'Host details'}
        testIdRoot="host-detail"
      >
        {selectedHost && <HostDetailPanel host={selectedHost} />}
      </SlideoutDetailPanel>
    </div>
  );
}

export default HostTab;
