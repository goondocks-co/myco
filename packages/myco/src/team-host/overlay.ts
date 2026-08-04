/**
 * `myco host enable` / `host disable` orchestration.
 *
 * Enabling a host is now a bookkeeping operation, not an installation: designate
 * the Grove this machine serves, record its identity, write the machine-tier
 * `host_serve` leaf, and restart the daemon so it binds the team listener. There
 * is nothing to download, no control plane to render, and no service to install
 * — the listener rides the daemon that is already running, on a socket derived
 * from `MYCO_HOME`.
 *
 * That is the whole point of the transport change. This module used to provision
 * two binaries, render and supervise a Headscale control plane, bring up a
 * userspace tailscaled, mint a pre-auth key, join the host to its own overlay,
 * and wire an inbound `serve --tcp` forward — each step with its own failure,
 * privilege, and convergence story, and a teardown that had to prove every one
 * of them gone before destroying identity. None of it survives, so none of its
 * failure modes do either.
 *
 * IDEMPOTENT / RESUMABLE: a re-run converges. Designation is immutable once set,
 * so a second enable re-affirms the same Grove rather than moving the team's
 * storage; every write is atomic temp+rename or a validated tier write.
 *
 * PRIVILEGE: none. Enabling a host requires no elevation on any platform.
 */
import os from 'node:os';

import { createHostId } from '@myco/grove/ids.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHostControlDir, resolveMycoHome } from '@myco/grove/paths.js';
import { loadMachineConfig } from '@myco/config/loader.js';
import { createGrove, ensureDefaultGrove, listGroves, loadGroveRecord, resolveDefaultGrove } from '@myco/grove/registry.js';
import { seedGroveBackupDefaults } from '@myco/backup/service.js';
import { getServiceManager } from '@myco/service/manager.js';
import type { ServiceManager } from '@myco/service/types.js';
import { restartDaemonForHostServe, writeHostServeConfig } from './daemon-apply.js';
import { deactivateTeamFunnel, teamFunnelContainmentSockets, teamHostingPreflight } from './funnel.js';
import { clearHostState, readHostState, writeHostState } from './state.js';

export interface HostEnableOptions {
  /** Host node label members see. Default: sanitized `os.hostname()`. */
  hostname?: string;
  /**
   * How served-grove designation resolves when no designation exists yet
   * (server-mode design spec §2). Ignored on a re-run that already has one —
   * designation is immutable once set (see {@link resolveServedGroveDesignation}).
   *   - `'default'` (the fresh-box / installer `--serve` path): resolves or
   *     creates the canonical default Grove (`ensureDefaultGrove`) — the
   *     box's default Grove IS the team storage.
   *   - `'fresh'` (a user instance enabling the capability on an existing
   *     personal daemon): creates a brand-new Grove dedicated to serving,
   *     crash-resumable via a durable intent marker. An existing personal
   *     Grove is never designated.
   * REQUIRED on a machine that already has Groves and no designation yet — a
   * silent `'default'` here designated the user's PERSONAL Grove as team
   * storage, immutably.
   */
  groveDesignation?: 'default' | 'fresh';
  /**
   * Name for the team storage created by `'fresh'` designation (E1 §8 Q3:
   * the enabling user names it, CLI and UI both). Fallback: `'Team Host'`.
   * On a re-run with a designation already on record the name is IGNORED
   * WITH A NOTE — designation is immutable once set, and silence would
   * mean the user typed a name and watched it not take effect.
   */
  storageName?: string;
}

export interface HostEnableDeps {
  mycoHome?: string;
  platform?: NodeJS.Platform;
  /** Test seam: override the Tailscale-build preflight. */
  preflight?: typeof teamHostingPreflight;
  /** Withdraw the host's public URL (disable only). Default: the vendor
   *  Funnel-off runner against this machine's team socket. */
  withdrawFunnel?: (socketPath: string) => Promise<{ ok: boolean; detail: string }>;
  serviceManager?: ServiceManager;
  /** Restart THIS machine's Myco daemon so it (un)binds the team listener.
   *  Default: `restartDaemonForHostServe` via the platform manager. The
   *  host-admin routes inject a DEFERRING implementation here, because the
   *  restart SIGTERMs the very process running this orchestration. */
  restartDaemon?: (mycoHome: string) => Promise<import('./daemon-apply.js').DaemonRestartResult>;
  logger?: (message: string) => void;
}

export interface HostEnableResult {
  hostId: string;
  /** Host node label members see. */
  label: string;
  daemonRestarted: boolean;
  /** The Grove this host is designated to serve (`served_grove_id`). */
  servedGroveId: string;
  notes: string[];
}
// ---------------------------------------------------------------------------
// Served-grove designation (server-mode design spec §2)
// ---------------------------------------------------------------------------

/** Filename of the crash-resumable create-fresh intent marker, under the
 *  host control dir ({@link resolveHostControlDir}). */
export const DESIGNATION_INTENT_FILENAME = 'designation-intent.json';

interface DesignationIntent {
  grove_id: string;
  created_at: string;
}

function designationIntentPath(controlDir: string): string {
  return path.join(controlDir, DESIGNATION_INTENT_FILENAME);
}

/** Read the create-fresh intent marker, or null when absent, corrupt, or
 *  unreadable — a bad marker is treated the same as no marker (falls
 *  through to creating a fresh Grove), never a thrown error. */
function readDesignationIntent(controlDir: string): DesignationIntent | null {
  let raw: string;
  try {
    raw = fs.readFileSync(designationIntentPath(controlDir), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DesignationIntent>;
    if (typeof parsed.grove_id !== 'string' || !parsed.grove_id) return null;
    return { grove_id: parsed.grove_id, created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date(0).toISOString() };
  } catch {
    return null;
  }
}

function writeDesignationIntent(controlDir: string, groveId: string): void {
  fs.mkdirSync(controlDir, { recursive: true });
  const doc: DesignationIntent = { grove_id: groveId, created_at: new Date().toISOString() };
  fs.writeFileSync(designationIntentPath(controlDir), `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
}

/** Remove the create-fresh intent marker. Safe to call when absent (a
 *  `'default'`-mode designation never wrote one). Call ONLY after the
 *  designation is durably persisted (`writeHostServeConfig` succeeded) —
 *  never before, or a crash between clearing and persisting would strand
 *  the created Grove with no way to resume adopting it. */
function clearDesignationIntent(controlDir: string): void {
  fs.rmSync(designationIntentPath(controlDir), { force: true });
}

/**
 * Create-or-reuse a fresh Grove dedicated to Team Host serving — the
 * user-instance designation path (an existing personal Grove is never
 * designated). Crash-resumable: the created Grove id is recorded to the
 * intent marker BEFORE this function returns, so a re-run whose previous
 * attempt crashed before the designation itself was persisted adopts the
 * SAME Grove instead of minting a second orphan.
 */
function createOrAdoptFreshServedGrove(
  mycoHome: string,
  controlDir: string,
  log: (message: string) => void,
  storageName?: string,
): string {
  const intent = readDesignationIntent(controlDir);
  if (intent) {
    const existing = loadGroveRecord(intent.grove_id, mycoHome);
    if (existing) {
      log(`Resuming an interrupted Team Host enable: adopting the Grove already created for serving ("${existing.name}", ${existing.id}) instead of creating a second one.`);
      return existing.id;
    }
    // The marker names a Grove that no longer exists (e.g. deleted out of
    // band) — stale marker, fall through to creating a fresh Grove below.
  }
  // Disable→re-enable ADOPTS the team's previous storage (E1 §4.1 rev 5;
  // "this state should not be possible"): `host disable` records the
  // outgoing served grove, and creating a second one here would orphan the
  // team's entire attached history — then crash on the name collision.
  const lastServed = loadMachineConfig(mycoHome).daemon.host_serve.last_served_grove_id ?? undefined;
  if (lastServed) {
    const previous = loadGroveRecord(lastServed, mycoHome);
    if (previous) {
      const requested = storageName?.trim();
      if (requested && requested !== previous.name) {
        // An explicitly DIFFERENT name is the user's escape hatch to new
        // storage (PR 2 diff review, C5 — without this, "start a new team
        // on this box" had no path short of hand-editing config.yaml). The
        // previous Grove is KEPT, stated out loud, never silently orphaned.
        log(`NOTE: previous team storage "${previous.name}" (${previous.id}) is KEPT but not adopted — you asked for new storage "${requested}". The old Grove and its history remain on this machine.`);
      } else {
        // Ignore-with-a-note parity with the immutable-designation path:
        // adoption must never silently swallow a typed name.
        log(`Re-enabling Team Host: adopting the previously-served team storage ("${previous.name}", ${previous.id}) — its attached history is intact.`);
        writeDesignationIntent(controlDir, previous.id);
        return previous.id;
      }
    }
  }
  const name = storageName?.trim() || 'Team Host';
  let grove: ReturnType<typeof createGrove>;
  try {
    grove = createGrove(name, mycoHome);
  } catch (err) {
    // A name/slug collision with an EXISTING grove is a refusal, never an
    // adoption: the only groves this path may adopt arrive via the two safe
    // channels above (crash-resume intent, previously-served storage) —
    // designating an arbitrary same-named grove is exactly the personal-
    // grove hazard decision-963ca301 forbids.
    throw new Error(
      `Cannot create team storage "${name}": ${err instanceof Error ? err.message : String(err)}. `
      + 'Pass a different --storage-name (an existing Grove is never designated as team storage).',
    );
  }
  writeDesignationIntent(controlDir, grove.id);
  return grove.id;
}

/**
 * Resolve served-grove designation for this `hostEnable` run — create-or-
 * reuse when none exists yet, VERIFY (never re-derive) when one is already
 * present (server-mode design spec §2: "immutable once set").
 *
 * A designation already on record is authoritative. This function checks it
 * still names an existing Grove and, in `'default'` mode, warns (without
 * moving) if the default-Grove pointer has since moved to a different
 * Grove — the default pointer's movement must never re-point a serving box
 * and strand attach refs. It never returns a different Grove id than the
 * one it was handed once a designation exists.
 */
export function resolveServedGroveDesignation(
  mode: 'default' | 'fresh',
  existingServedGroveId: string | undefined,
  mycoHome: string,
  controlDir: string,
  log: (message: string) => void,
  storageName?: string,
): { groveId: string; warning?: string } {
  if (existingServedGroveId) {
    const grove = loadGroveRecord(existingServedGroveId, mycoHome);
    // Ignore-with-a-note, never silently (E1 §4.1 rev 6): the designation is
    // immutable once set, and the common case (converge re-run) would
    // otherwise swallow a name the user typed.
    if (storageName?.trim() && grove && grove.name !== storageName.trim()) {
      log(`NOTE: --storage-name "${storageName.trim()}" ignored — this host already serves "${grove.name}" (designation is immutable once set; disable and re-enable to change it).`);
    }
    if (!grove) {
      const warning = `served_grove_id ${existingServedGroveId} no longer names a Grove on this machine — the designation is dangling (see \`myco doctor\`). Team Host serving stays off until this is resolved; the designation was NOT silently replaced.`;
      log(`WARNING: ${warning}`);
      return { groveId: existingServedGroveId, warning };
    }
    if (mode === 'default') {
      const currentDefault = resolveDefaultGrove(mycoHome);
      if (currentDefault && currentDefault.id !== existingServedGroveId) {
        const warning = `The default Grove pointer now points to "${currentDefault.name}" (${currentDefault.id}), but this host is designated to serve "${grove.name}" (${grove.id}) — designation is immutable once set and was NOT re-pointed. Disable and re-enable Team Host serving to designate a different Grove.`;
        log(`WARNING: ${warning}`);
        return { groveId: existingServedGroveId, warning };
      }
    }
    return { groveId: existingServedGroveId };
  }

  if (mode === 'fresh') {
    return { groveId: createOrAdoptFreshServedGrove(mycoHome, controlDir, log, storageName) };
  }
  return { groveId: ensureDefaultGrove(mycoHome).id };
}

/**
 * The designation mode for this run — EXPLICIT on first designation (rev 6
 * breaking change). The old silent `?? 'default'` designated the machine's
 * existing default Grove as team storage, immutably: on a personal machine
 * that is the user's personal Grove, violating decision-963ca301. A re-run
 * with a designation on record needs no choice (designation is immutable;
 * the mode only affects the default-pointer drift warn).
 */
export function resolveDesignationMode(
  requested: 'default' | 'fresh' | undefined,
  existingServedGroveId: string | undefined,
  mycoHome: string,
): 'default' | 'fresh' {
  if (requested) return requested;
  if (existingServedGroveId) return 'default';
  let hasGroves = false;
  try {
    hasGroves = listGroves(mycoHome).length > 0;
  } catch { /* unreadable registry — fall through to the safe refusal below */ hasGroves = true; }
  if (hasGroves) {
    throw new Error(
      'This machine already has project storage (Groves), so `myco host enable` needs an explicit choice: '
      + '--designate-fresh creates NEW dedicated team storage (optionally named via --storage-name); '
      + '--designate-default serves this box\'s default Grove (the --serve installer path). '
      + 'An existing personal Grove is never designated silently.',
    );
  }
  return 'default';
}

/**
 * Validate a prospective fresh-designation BEFORE any binaries are
 * provisioned or services touched (E1 §4.1 rev 6: "the route must validate
 * storage_name against the registry before touching binaries or services").
 * Collisions with the two safe adoption channels (crash-resume intent,
 * previously-served storage) are NOT refusals — those are the groves the
 * designation will adopt.
 */
export function validateFreshDesignationName(
  storageName: string | undefined,
  mycoHome: string,
  controlDir: string,
): void {
  const name = storageName?.trim() || 'Team Host';
  const intentGroveId = readDesignationIntent(controlDir)?.grove_id;
  // The previously-served Grove is excluded from collision detection ONLY
  // when the requested name matches it — that is the adoption path. A
  // different name means "new storage", and colliding with any OTHER
  // existing grove (including a renamed last-served one) is a refusal.
  const lastServedId = loadMachineConfig(mycoHome).daemon.host_serve.last_served_grove_id ?? undefined;
  const lastServedGrove = lastServedId ? loadGroveRecord(lastServedId, mycoHome) : undefined;
  let collision: { id: string; name: string } | undefined;
  try {
    collision = listGroves(mycoHome).find((g) =>
      g.name === name
      && g.id !== intentGroveId
      && !(g.id === lastServedId && lastServedGrove?.name === name));
  } catch { return; /* unreadable registry — createGrove's own refusal is the backstop */ }
  if (collision) {
    throw new Error(
      `Team storage name "${name}" already names a Grove on this machine (${collision.id}). `
      + 'Pass a different --storage-name — an existing Grove is never designated as team storage.',
    );
  }
}

/** How long to wait for a freshly-installed host tailscaled to bind its control
 *  socket before failing loudly. Mirrors the member's own start-up race budget. */

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

export async function hostEnable(options: HostEnableOptions, deps: HostEnableDeps = {}): Promise<HostEnableResult> {
  const log = deps.logger ?? ((m: string) => console.log(m));
  const notes: string[] = [];
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const platform = deps.platform ?? process.platform;
  const label = sanitizeHostname(options.hostname ?? os.hostname());
  const controlDir = resolveHostControlDir();

  // Transport preflight — refuse BEFORE any durable write, for the same reason
  // the designation checks below do: a machine whose Tailscale cannot serve a
  // unix socket will never publish a URL, and finding that out after the config
  // is written and the daemon has restarted turns a clear "install the other
  // Tailscale" into a half-enabled host the operator has to tear down.
  //
  // One-sided by construction — it refuses what it recognizes and stays quiet
  // otherwise. The activation probe at boot is what actually gates serving.
  const refusal = (deps.preflight ?? teamHostingPreflight)({ platform });
  if (refusal) throw new Error(refusal);

  // Designation preflight — refuse BEFORE any durable write (E1 §4.1 rev 6):
  // the explicit-choice requirement and a storage-name collision are user
  // errors, and surfacing them after a partial enable converts a typo into a
  // teardown.
  const preExistingServedGroveId = loadMachineConfig(mycoHome).daemon.host_serve.served_grove_id ?? undefined;
  const designationMode = resolveDesignationMode(options.groveDesignation, preExistingServedGroveId, mycoHome);
  if (!preExistingServedGroveId && designationMode === 'fresh') {
    validateFreshDesignationName(options.storageName, mycoHome, resolveHostControlDir());
  }

  const designation = resolveServedGroveDesignation(
    designationMode,
    preExistingServedGroveId,
    mycoHome,
    controlDir,
    log,
    options.storageName,
  );
  if (designation.warning) notes.push(designation.warning);

  const existingState = readHostState();
  const hostId = existingState?.host_id ?? createHostId();

  writeHostServeConfig({
    enabled: true,
    hostId,
    label,
    servedGroveId: designation.groveId,
  }, mycoHome);
  // Only clear a create-fresh marker once the designation it points at is
  // actually durable — see `clearDesignationIntent`'s ordering contract.
  clearDesignationIntent(controlDir);
  // Seed the served Grove's backup defaults now that the designation is
  // durable (server-mode design spec §8 — backups default-on for the served
  // Grove). Skipped for a dangling designation (the Grove doesn't exist on
  // this machine, e.g. an unresolved warning above) — nothing to seed.
  if (loadGroveRecord(designation.groveId, mycoHome)) {
    seedGroveBackupDefaults(designation.groveId, mycoHome);
  }

  writeHostState({
    host_id: hostId,
    enabled_at: existingState?.enabled_at ?? new Date().toISOString(),
    label,
    platform,
    // The URL is NOT written here. It is not something this machine chooses —
    // it is what the tailnet reports when the Funnel activates, which happens
    // after the restart below, on the daemon that owns the socket.
  });

  // TERMINAL: restart the daemon to bind the team listener. Last on purpose —
  // all durable state is already written, so when this runs in-daemon the
  // SIGTERM lands after nothing that matters, and a re-run converges from disk.
  const restart = await (deps.restartDaemon
    ?? ((home: string) => restartDaemonForHostServe(home, deps.serviceManager ?? getServiceManager())))(mycoHome);
  log(restart.detail);
  if (!restart.restarted) {
    const warning = `${restart.detail} This host does not serve until the daemon restarts.`;
    log(`WARNING: ${warning}`);
    notes.push(warning);
  }

  return { hostId, label, daemonRestarted: restart.restarted, servedGroveId: designation.groveId, notes };
}

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

export interface HostDisableResult {
  cleared: boolean;
  errors: string[];
  daemonRestarted: boolean;
}

/**
 * Tear down host serving: clear the config, destroy host identity and the serve
 * credential, then restart the daemon so it unbinds the team listener.
 *
 * The old teardown had to stop two services and PROVE them gone before
 * destroying identity, because a failed uninstall left a live tailscaled with
 * in-memory identity and wiped state to converge from. A host owns no processes
 * now, so that ordering hazard does not exist: the steps below are independent
 * disk writes, each tolerating an already-absent resource, and a retry after a
 * partial failure converges.
 *
 * The restart stays TERMINAL — run in-daemon it SIGTERMs the process executing
 * this teardown, so nothing after it is guaranteed to run.
 */
export async function hostDisable(deps: HostEnableDeps = {}): Promise<HostDisableResult> {
  const log = deps.logger ?? ((m: string) => console.log(m));
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const errors: string[] = [];
  let daemonRestarted = false;

  const step = async (label: string, run: () => Promise<void>): Promise<void> => {
    try { await run(); } catch (err) { errors.push(`${label}: ${(err as Error).message}`); }
  };

  // FIRST, and before any state is cleared: a host that stops hosting must stop
  // being publicly addressable. Ordering is the point — the config and state
  // cleared below are the only evidence that a Funnel was ever activated, so
  // withdrawing after clearing them would strand a live public URL in front of
  // a socket nothing binds, with nothing left on disk to find it by.
  //
  // Gated on that same evidence, and the gate is load-bearing: withdrawing runs
  // the operator's vendor `tailscale` CLI, and `host disable` on a machine that
  // never hosted must not touch it at all. Same rule containment uses, for the
  // same reason.
  //
  // A failure here does NOT abort the disable, but it DOES hold back the two
  // writes that erase the evidence — see `withdrawn` below. Serving stops
  // either way (the daemon restarts and unbinds the socket); what is preserved
  // is the ability to find a URL that outlived its host.
  const exposedSockets = teamFunnelContainmentSockets({ mycoHome, intent: 'quiesce' });
  let withdrawn = true;
  for (const socketPath of exposedSockets) {
    await step('withdraw public URL', async () => {
      const withdraw = deps.withdrawFunnel
        ?? (async (socket: string) => {
          const { defaultFunnelOffRunner } = await import('@myco/daemon/external-listener.js');
          return await deactivateTeamFunnel(socket, defaultFunnelOffRunner);
        });
      const result = await withdraw(socketPath);
      log(result.detail);
      if (!result.ok) {
        withdrawn = false;
        throw new Error(
          `${result.detail} The public URL may still be advertised — run \`myco doctor\` to check for leftover exposure.`,
        );
      }
    });
  }

  if (withdrawn) {
    await step('clear host_serve config', async () => {
      writeHostServeConfig({ enabled: false }, mycoHome);
    });
    await step('clear host state', async () => { clearHostState(); });
  } else {
    // The ordering above exists so a live URL is never stranded with nothing on
    // disk to find it by — and clearing anyway on the failure branch would do
    // precisely that. `host_serve.enabled` and the host state file are the ONLY
    // evidence the boot sweep's `retire` intent keys on, so they stay until the
    // withdrawal actually confirms. The next boot retries; a re-run of `host
    // disable` retries; and the daemon restart below still stops this machine
    // serving in the meantime.
    const warning = 'Host serving state was KEPT so the leftover public URL can still be found and '
      + 'withdrawn — re-run `myco host disable` once Tailscale is reachable. This machine stops '
      + 'serving regardless when the daemon restarts.';
    log(`WARNING: ${warning}`);
    errors.push(warning);
  }
  await step('clear serve bearer', async () => {
    const { deleteSecrets } = await import('@myco/config/secrets.js');
    const { HOST_SERVE_BEARER_SECRET } = await import('@myco/constants.js');
    deleteSecrets(mycoHome, [HOST_SERVE_BEARER_SECRET]);
  });

  // TERMINAL: restart so the daemon re-reads the cleared config and unbinds.
  await step('restart daemon', async () => {
    const r = await (deps.restartDaemon
      ?? ((home: string) => restartDaemonForHostServe(home, deps.serviceManager ?? getServiceManager())))(mycoHome);
    daemonRestarted = r.restarted;
    log(r.detail);
  });

  if (errors.length > 0) {
    for (const e of errors) log(`ERROR: ${e}`);
  }
  return { cleared: errors.length === 0, errors, daemonRestarted };
}

/** Node-name sanitizer: a label members see, safe for display and logs. */
function sanitizeHostname(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'myco-host';
}
