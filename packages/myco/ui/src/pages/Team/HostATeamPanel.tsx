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
 * "Host a team" — the fork's left panel (E1 §5.1). Fully in-UI and
 * ZERO-SUDO on the default path (both platforms; §3.2): the form submits
 * `POST /api/host-admin/enable`, renders the job's step log, and completes
 * on the OBSERVED Phase-2 read (`serving && overlay_listener_bound &&
 * started_at` changed — never the config-derived flag alone).
 *
 * The run is reconstructible from the two GET routes alone, so a MANUAL
 * refresh during the wait resumes cleanly (the machine-scoped page sends
 * no context-switching headers, so the daemon's fresh auth token forces
 * no reload here — review N8). The persisted marker is TTL'd: a dead run
 * can never wedge the fork (review B1).
 */
import { useEffect, useState } from 'react';
import { Server, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Panel } from '../../components/ui/panel';
import { IconEyebrow } from '../../components/ui/icon-eyebrow';
import { Button } from '../../components/ui/button';
import {
  useHostAdminEnable,
  useHostAdminProgress,
  useHostServePhase2,
} from '../../hooks/use-host-admin';
import { useHostMembershipStatus } from '../../hooks/use-host-membership';

const inputClass =
  'rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40';
const labelClass = 'myco-eyebrow-sm text-on-surface-variant';

/** Persisted run marker so a MANUAL refresh during the wait resumes the
 *  Phase-2 poll instead of losing the run. Shape-validated and TTL'd on
 *  restore (review B1): a stale or malformed marker must never wedge the
 *  fork — an expired run is dropped in the initializer, before render. */
const ENABLE_RUN_KEY = 'myco.hostEnableRun';
export const ENABLE_RUN_TTL_MS = 20 * 60 * 1000;

interface EnableRun { token: string; snapshot: string | null; startedAtMs: number; }

function readRun(): EnableRun | null {
  try {
    const raw = localStorage.getItem(ENABLE_RUN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EnableRun>;
    if (typeof parsed.token !== 'string' || !parsed.token
      || typeof parsed.startedAtMs !== 'number'
      || Date.now() - parsed.startedAtMs > ENABLE_RUN_TTL_MS) {
      localStorage.removeItem(ENABLE_RUN_KEY);
      return null;
    }
    return {
      token: parsed.token,
      snapshot: typeof parsed.snapshot === 'string' ? parsed.snapshot : null,
      startedAtMs: parsed.startedAtMs,
    };
  } catch { return null; }
}

function hostAdminErrorCopy(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/host_admin_unsupported/.test(message)) {
    return 'This machine can join a team, but hosting is not supported on this operating system.';
  }
  if (/host_admin_requires_cli/.test(message)) {
    return 'This machine’s daemon starts at boot, so enabling needs one elevated step the browser can’t run. Run `myco host enable` from a terminal instead.';
  }
  if (/busy/.test(message)) {
    return 'Another operation is in progress — try again when it finishes.';
  }
  return message;
}

export function HostATeamPanel({ collapsed = false }: { collapsed?: boolean }) {
  const status = useHostMembershipStatus();
  const overlaySupported = status.data?.overlay_supported !== false;
  const enable = useHostAdminEnable();
  const [expanded, setExpanded] = useState(!collapsed);
  const [storageName, setStorageName] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<EnableRun | null>(readRun);

  const progress = useHostAdminProgress(run?.token ?? null);
  const jobStatus = progress.data?.status;
  const jobGone = run !== null && progress.data === null && progress.isFetched;
  // Phase 2 arms once the job is terminal-complete OR its token 404s (the
  // daemon bounced after writing the terminal step).
  const phase2Active = run !== null && (jobStatus === 'completed' || jobGone);
  const phase2 = useHostServePhase2({
    active: phase2Active,
    token: run?.token ?? null,
    snapshot: run?.snapshot ?? null,
    armedAt: run?.startedAtMs ?? 0,
    direction: 'enable',
  });

  const done = phase2.data?.done === true;
  const phase2Failed = phase2.data?.failed ?? null;
  const phase2TimedOut = phase2.data?.timedOut === true;
  const jobFailed = jobStatus === 'failed';
  // Clear the persisted marker as an EFFECT, never in the render body
  // (review C2: a render-body setRun(null) discarded the very render that
  // showed success — the "Done" state was dead code). `run` stays set so
  // the success UI actually commits; only Dismiss drops it.
  useEffect(() => {
    if (done) { try { localStorage.removeItem(ENABLE_RUN_KEY); } catch { /* private mode */ } }
  }, [done]);
  const dismissRun = () => {
    try { localStorage.removeItem(ENABLE_RUN_KEY); } catch { /* private mode */ }
    setRun(null);
  };
  // The escape hatch renders in EVERY non-done state (review B1): the old
  // gate (jobFailed || done) structurally forbade the re-run its own
  // failure copy instructed, and a deferred/failed restart left an
  // unbounded spinner with no exit. Dismissing never aborts the server job
  // — the copy says so — it only frees this form.
  const dismissable = run !== null && !done;

  const canSubmit = overlaySupported && !enable.isPending && run === null;

  const handleEnable = async () => {
    setError(null);
    try {
      const res = await enable.mutateAsync({
        ...(storageName.trim() ? { storage_name: storageName.trim() } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      const next: EnableRun = { token: res.token, snapshot: res.started_at, startedAtMs: Date.now() };
      try { localStorage.setItem(ENABLE_RUN_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      setRun(next);
    } catch (err) {
      setError(hostAdminErrorCopy(err));
    }
  };

  if (!expanded) {
    return (
      <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
        Host another team…
      </Button>
    );
  }

  return (
    <Panel tone="sage" eyebrow={<IconEyebrow Icon={Server}>Team Host</IconEyebrow>} title="Host a team">
      <p className="text-xs text-on-surface-variant m-0 mb-3">
        Turn this machine into your team’s host — it stores the team’s shared knowledge and serves
        your teammates. Best on an always-on machine. Runs entirely as your user; nothing to install, no
        administrator password. Myco publishes the address teammates dial through your Tailscale; you’ll
        see it here once hosting starts. This host is reachable while you’re logged in — to make it
        survive reboots unattended, run <code className="font-mono">myco service install</code> afterwards.
      </p>
      {!overlaySupported && (
        <p className="text-xs text-terracotta-text m-0 mb-3">
          Hosting isn’t supported on this operating system — this machine can still join a team as a member.
        </p>
      )}
      {run === null ? (
        <div className="flex flex-col gap-2">
          <label className={labelClass} htmlFor="host-enable-storage-name">Team storage name</label>
          <input id="host-enable-storage-name" className={inputClass} value={storageName} onChange={(e) => setStorageName(e.target.value)} placeholder="Team Host" />
          <p className="text-xs text-on-surface-variant m-0">
            This creates your team’s storage — fresh and dedicated; your personal projects stay yours.
          </p>
          <label className={labelClass} htmlFor="host-enable-label">Host label (optional)</label>
          <input id="host-enable-label" className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={window.location.hostname || 'this machine'} />
          <div className="flex justify-end">
            <Button size="sm" disabled={!canSubmit} onClick={handleEnable}>
              {enable.isPending ? 'Starting…' : 'Host a team'}
            </Button>
          </div>
          {error && <p className="text-sm text-terracotta m-0" data-testid="host-enable-error">{error}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="host-enable-progress">
          <div className="flex items-center gap-2">
            {done
              ? <CheckCircle2 className="size-4 text-sage" aria-hidden />
              : (jobFailed || phase2Failed)
                ? <AlertTriangle className="size-4 text-terracotta" aria-hidden />
                : <Loader2 className="size-4 animate-spin text-sage" aria-hidden />}
            <span className="text-sm text-on-surface">
              {done
                ? 'This machine is now serving your team.'
                : jobFailed
                  ? 'Enable failed — the step log below has the details. Dismiss and re-run; it picks up where it left off.'
                  : phase2TimedOut
                    ? 'The host has not come up yet. It may still finish in the background — check back, or dismiss and re-run to converge.'
                    : phase2Failed
                      ? `The daemon restarted but isn’t serving yet (${phase2Failed}) — still watching. Dismiss and re-run to converge now.`
                      : phase2Active
                        ? 'Restarting the daemon and waiting for the host to come up…'
                        : 'Setting up your team host…'}
            </span>
          </div>
          {(progress.data?.steps?.length ?? 0) > 0 && (
            <ol className="m-0 flex list-none flex-col gap-1 p-0" data-testid="host-enable-steps">
              {progress.data!.steps!.map((step, i) => (
                <li key={i} className="text-xs font-mono text-on-surface-variant">{step}</li>
              ))}
            </ol>
          )}
          <div className="flex justify-end">
            {done ? (
              <Button size="sm" variant="outline" onClick={dismissRun} data-testid="host-enable-done">
                Done
              </Button>
            ) : dismissable ? (
              <Button size="sm" variant="ghost" onClick={dismissRun} data-testid="host-enable-dismiss">
                Dismiss (the setup keeps running on the daemon)
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  );
}
