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
 * Team Host ADMINISTRATION routes (E1 spec §4) — the daemon-side family that
 * makes hosting a first-class UI action instead of a CLI-only capability:
 *
 *   - `POST /api/host-admin/enable`        — become a Team Host (async job)
 *   - `POST /api/host-admin/disable`       — stop hosting (async job)
 *   - `POST /api/host-admin/mint-join-key` — one-time member join command
 *
 * All localhost-only (`HOST_ADMIN` stamp, the host-membership posture). The
 * enable/disable jobs run PLAIN `hostEnable`/`hostDisable` — never the
 * compose orchestration (§4.1: compose exists to mint a key and emit a join
 * command in one shot; that mint would duplicate `mint-join-key`, which the
 * UI surfaces as its own button).
 *
 * EXECUTION MODEL (§4.1 rev 6). `hostEnable`'s terminal step restarts the
 * daemon; run in-process, an inline restart SIGTERMs the process executing
 * this job. So: the job injects the EXPLICIT `restartDaemon` seam (never a
 * fake ServiceManager — `serviceManager` supervises tailscaled/headscale,
 * and impersonating it no-ops the overlay install and the §15 prove-gone
 * gates; diff review BLOCKER 1) whose implementation only records that a
 * restart was requested; the tracker's final status and step log are
 * written FIRST (`ProgressTracker` is in-memory and dies with the restart);
 * only then is the restart scheduled through the detached-child pattern
 * (`scheduleDetachedSelfRestart`), and only when no OTHER progress-tracked
 * operation is active. Enable and disable share ONE tracker type
 * ('host-admin') so they mutually exclude, and every job carries a
 * 15-minute watchdog so a hung orchestration cannot wedge the dedupe or
 * the restart route's busy guard forever. Phase 2 belongs to
 * the CLIENT: poll `GET /api/host-serve/status` until
 * `serving && overlay_listener_bound && started_at !== <this response's
 * started_at>` — the config-derived `serving` flag alone survives every bind
 * failure, and without the restart discriminator the poll can succeed
 * against the dying pre-restart process (a 15s cache makes that the common
 * case, not the race).
 *
 * TYPED REFUSALS, before any work (§2.6, §4.1):
 *   - `host_admin_unsupported`  — win32 (member-only platform), never a 500.
 *   - `host_admin_requires_cli` — darwin + `daemon.service_scope: boot`: the
 *     system-domain unit step needs sudo, the daemon cannot elevate, and the
 *     `needs_privilege` pause machinery was deleted with the migration
 *     (rev 5). The CLI prompts natively; the route says so.
 *   - `daemon_home_unsafe`      — a daemon with no sane HOME would anchor the
 *     host-control home under /var/root (§4.1 prerequisite).
 */
import os from 'node:os';

import { loadMachineConfig } from '@myco/config/loader.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { hostDisable, hostEnable, type HostEnableDeps } from '@myco/team-host/overlay.js';
import { readHostState } from '@myco/team-host/state.js';
import { writeTeamAgentKey } from '@myco/team-host/team-secret.js';
import { resolveTeamKeyProviderFlag } from '@myco/team-host/compose.js';
import type { RouteHandler, RouteResponse } from '../router.js';
import type { ProgressTracker } from './progress.js';

export interface HostAdminRouteDeps {
  tracker: ProgressTracker;
  /** This process's start stamp — returned on enable/disable responses as
   *  the client's pre-restart snapshot for the Phase-2 discriminator. */
  startedAt: () => string;
  /** Schedule THIS daemon's restart via the detached-child pattern. Called
   *  strictly AFTER the job's terminal tracker state is written. Receives
   *  the job's token so the scheduler can append a step when it must
   *  DEFER instead (other progress-tracked operations active — the same
   *  guard `POST /api/restart` enforces; diff review C2). */
  scheduleRestart: (opts: { token: string }) => void;
  mycoHome?: string;
  platform?: NodeJS.Platform;
  /** Test seams. */
  runHostEnable?: typeof hostEnable;
  runHostDisable?: typeof hostDisable;
  hostEnableDeps?: Partial<HostEnableDeps>;
}

function refusal(status: number, error: string, message: string): RouteResponse {
  return { status, body: { error, message } };
}

/** The three preflight refusals shared by enable/disable. Mint skips the
 *  boot-scope one — key minting is unprivileged at every scope post-PR-1. */
function refuseHostAdmin(
  deps: HostAdminRouteDeps,
  opts: { forMutation: boolean },
): RouteResponse | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    return refusal(422, 'host_admin_unsupported',
      'Team hosting is not supported on this operating system yet — and neither is joining: '
      + 'Myco\'s overlay client has no build for it. Everything else in Myco works normally here.');
  }
  const home = (() => { try { return os.homedir(); } catch { return ''; } })();
  if (!home || home === '/var/root' || process.getuid?.() === 0) {
    return refusal(500, 'daemon_home_unsafe',
      'The daemon is running without a sane user HOME — the host-control home would land under root. '
      + 'Reinstall the daemon service without sudo (`myco service install`).');
  }
  if (opts.forMutation && platform === 'darwin') {
    try {
      const scope = loadMachineConfig(deps.mycoHome ?? resolveMycoHome()).daemon.service_scope;
      if (scope === 'boot') {
        return refusal(409, 'host_admin_requires_cli',
          'This machine\'s daemon is boot-scoped, so the headscale unit lives in the system domain and '
          + 'enable/disable need sudo — which the daemon cannot request. Run `myco host enable` (or '
          + '`myco host disable`) from a terminal; Myco elevates only the individual steps that need it.');
      }
    } catch { /* unreadable config — the orchestration's own guards remain */ }
  }
  return null;
}

/** Per-job watchdog: a hung orchestration (e.g. `tailscale up` against a
 *  dead control plane) would otherwise pin a 'running' tracker entry for
 *  the life of the process — wedging the same-type dedupe AND
 *  `POST /api/restart`'s busy guard forever (diff review N7). The
 *  underlying work cannot be cancelled; the TRACKER is unwedged and the
 *  step log says so honestly. */
const HOST_ADMIN_JOB_TIMEOUT_MS = 15 * 60 * 1000;

async function withJobTimeout<T>(job: Promise<T>, onTimeout: () => void): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { onTimeout(); resolve('timeout'); }, HOST_ADMIN_JOB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([job, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface EnableBody {
  label?: unknown;
  storage_name?: unknown;
  team_provider_key?: unknown;
  team_key_provider?: unknown;
}

export function createHostAdminEnableHandler(deps: HostAdminRouteDeps): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const refused = refuseHostAdmin(deps, { forMutation: true });
    if (refused) return refused;
    const body = (req.body ?? {}) as EnableBody;
    // A PRESENT but non-string key is a refusal, not a silent drop — the
    // same silent-credential-loss class the provider requirement exists to
    // prevent (diff review N8).
    if (body.team_provider_key !== undefined && typeof body.team_provider_key !== 'string') {
      return refusal(400, 'invalid_request', 'team_provider_key must be a string.');
    }
    // Provider REQUIRED with a key on THIS surface (no silent 'anthropic':
    // the compose default files a non-Anthropic team's key under
    // ANTHROPIC_API_KEY — key present, dispatch keyless).
    const teamKey = typeof body.team_provider_key === 'string' ? body.team_provider_key.trim() : '';
    let provider: ReturnType<typeof resolveTeamKeyProviderFlag>;
    if (teamKey) {
      try {
        provider = resolveTeamKeyProviderFlag(
          typeof body.team_key_provider === 'string' ? body.team_key_provider : undefined,
        );
      } catch (err) {
        return refusal(400, 'invalid_request', err instanceof Error ? err.message : String(err));
      }
      if (!provider) {
        return refusal(400, 'invalid_request',
          'team_key_provider is required when team_provider_key is set — the key is stored under the provider\'s standard env name.');
      }
    }

    // ONE tracker type for the whole family: enable and disable mutually
    // exclude (diff review C3 — per-type dedupe let two tabs interleave
    // hostEnable and hostDisable over one config/db/statedir). The
    // concurrency-cap throw becomes a typed refusal, not a 500.
    let created: { token: string; isNew: boolean };
    try {
      created = deps.tracker.create('host-admin');
    } catch (err) {
      return refusal(503, 'busy', err instanceof Error ? err.message : String(err));
    }
    const { token, isNew } = created;
    const startedAt = deps.startedAt();
    if (!isNew) {
      // The two-tabs guard: a host-admin job is already running; hand back its token.
      return { status: 202, body: { token, started_at: startedAt, existing: true } };
    }

    const step = (message: string) => deps.tracker.appendStep(token, message);
    void (async () => {
      let restartRequested = false;
      let timedOut = false;
      const run = deps.runHostEnable ?? hostEnable;
      const job = (async () => {
        const result = await run(
          {
            hostname: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : undefined,
            // ALWAYS fresh on this route (§4.1): 'default' resolves the
            // machine's existing default Grove — on a personal machine that
            // designates the user's personal Grove as team storage,
            // immutably (decision-963ca301).
            groveDesignation: 'fresh',
            storageName: typeof body.storage_name === 'string' ? body.storage_name : undefined,
          },
          {
            ...deps.hostEnableDeps,
            mycoHome: deps.mycoHome,
            logger: step,
            // The EXPLICIT restart seam — never a fake ServiceManager:
            // `serviceManager` supervises tailscaled/headscale, and
            // impersonating it no-ops the overlay install and the §15
            // prove-gone gates (diff review, BLOCKER 1).
            restartDaemon: async () => {
              restartRequested = true;
              return { restarted: true, detail: 'Daemon restart deferred — scheduled after this job records its final state.' };
            },
          },
        );
        if (teamKey && provider) {
          const masked = writeTeamAgentKey({
            servedGroveId: result.servedGroveId,
            key: teamKey,
            provider,
            mycoHome: deps.mycoHome,
          });
          step(`Team agent key stored (${masked}) in the team storage secrets.`);
        }
      })();
      try {
        const outcome = await withJobTimeout(job, () => { timedOut = true; });
        if (outcome === 'timeout') {
          step(`Enable is still running after ${HOST_ADMIN_JOB_TIMEOUT_MS / 60000} minutes — marking this job failed so new operations are not blocked. Check the daemon log; a re-run converges.`);
          deps.tracker.update(token, { status: 'failed' });
          return;
        }
        // TERMINAL tracker state BEFORE the restart — the tracker is
        // in-memory and dies with the process; written after, the client
        // reads a 404 indistinguishable from a bad token.
        step(restartRequested
          ? 'Enable complete. Restarting the daemon to bind the overlay listener — poll /api/host-serve/status until serving && overlay_listener_bound && started_at changes.'
          : 'Enable complete. The daemon must be restarted manually (`myco restart`) to bind the overlay listener.');
        deps.tracker.update(token, { status: 'completed', percent: 100 });
      } catch (err) {
        if (timedOut) return; // the timeout branch already wrote terminal state
        step(`Enable failed: ${err instanceof Error ? err.message : String(err)}`);
        deps.tracker.update(token, { status: 'failed' });
        restartRequested = false;
      }
      if (restartRequested && !timedOut) deps.scheduleRestart({ token });
    })();

    return { status: 202, body: { token, started_at: startedAt } };
  };
}

export function createHostAdminDisableHandler(deps: HostAdminRouteDeps): RouteHandler {
  return async (): Promise<RouteResponse> => {
    const refused = refuseHostAdmin(deps, { forMutation: true });
    if (refused) return refused;
    let created: { token: string; isNew: boolean };
    try {
      created = deps.tracker.create('host-admin');
    } catch (err) {
      return refusal(503, 'busy', err instanceof Error ? err.message : String(err));
    }
    const { token, isNew } = created;
    const startedAt = deps.startedAt();
    if (!isNew) {
      return { status: 202, body: { token, started_at: startedAt, existing: true } };
    }
    const step = (message: string) => deps.tracker.appendStep(token, message);
    void (async () => {
      let restartRequested = false;
      let timedOut = false;
      const run = deps.runHostDisable ?? hostDisable;
      const job = run({
        ...deps.hostEnableDeps,
        mycoHome: deps.mycoHome,
        logger: step,
        restartDaemon: async () => {
          restartRequested = true;
          return { restarted: true, detail: 'Daemon restart deferred — scheduled after this job records its final state.' };
        },
      });
      try {
        const outcome = await withJobTimeout(job, () => { timedOut = true; });
        if (outcome === 'timeout') {
          step(`Disable is still running after ${HOST_ADMIN_JOB_TIMEOUT_MS / 60000} minutes — marking this job failed so new operations are not blocked. Check the daemon log; a retry converges.`);
          deps.tracker.update(token, { status: 'failed' });
          return;
        }
        if (outcome.errors.length > 0) {
          step(`Disable finished with ${outcome.errors.length} issue(s): ${outcome.errors.join('; ')}`);
          deps.tracker.update(token, { status: outcome.cleared ? 'completed' : 'failed' });
        } else {
          step('Team hosting disabled. Restarting the daemon to unbind the overlay listener.');
          deps.tracker.update(token, { status: 'completed', percent: 100 });
        }
      } catch (err) {
        if (timedOut) return;
        step(`Disable failed: ${err instanceof Error ? err.message : String(err)}`);
        deps.tracker.update(token, { status: 'failed' });
        restartRequested = false;
      }
      if (restartRequested && !timedOut) deps.scheduleRestart({ token });
    })();
    return { status: 202, body: { token, started_at: startedAt } };
  };
}

export function createHostAdminMintJoinKeyHandler(deps: HostAdminRouteDeps): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    // Minting is unprivileged at EVERY scope post-re-scope (the admin socket
    // is user-owned) — only the platform and HOME guards apply.
    const refused = refuseHostAdmin(deps, { forMutation: false });
    if (refused) return refused;
    const body = (req.body ?? {}) as { expiration?: unknown };
    const expiration = typeof body.expiration === 'string' && body.expiration.trim() ? body.expiration.trim() : '1h';
    const state = readHostState();
    const machine = loadMachineConfig(deps.mycoHome ?? resolveMycoHome());
    const hostServe = machine.daemon.host_serve;
    if (!state || !hostServe.enabled) {
      return refusal(409, 'not_a_host', 'This machine is not serving as a Team Host — enable hosting first.');
    }
    // Join-key minting is unavailable on this build. The key used to be a
    // headscale pre-auth key consumed by the member's `tailscale up` — the
    // daemon never saw it, and overlay membership, not the key, was the real
    // admission gate. The daemon-issued single-use key that replaces it lands
    // with the rebuilt enrollment route, so there is nothing to mint here yet.
    return refusal(
      503,
      'join_unavailable',
      'Inviting a member is unavailable on this build: team enrollment is being rebuilt on the public host URL.',
    );
  };
}

/** Register the host-admin route family (localhost-only, HOST_ADMIN stamp). */
export function registerHostAdminRoutes(
  server: { registerRoute(method: string, path: string, handler: RouteHandler): void },
  deps: HostAdminRouteDeps,
): void {
  server.registerRoute('POST', '/api/host-admin/enable', createHostAdminEnableHandler(deps));
  server.registerRoute('POST', '/api/host-admin/disable', createHostAdminDisableHandler(deps));
  server.registerRoute('POST', '/api/host-admin/mint-join-key', createHostAdminMintJoinKeyHandler(deps));
}
