/**
 * `myco host enable` / `host disable` orchestration.
 *
 * Stands up (or tears down) the OSS overlay — Headscale control plane + Tailscale
 * data plane — and wires the local daemon to serve over it. Every side effect runs behind an injectable seam ({@link HostEnableDeps})
 * so the whole flow unit-tests with no network, no sudo, and no real service
 * install; the true validation is the LIVE checklist in the task report.
 *
 * IDEMPOTENT / RESUMABLE: a re-run after a partial failure converges. Each step
 * checks already-done — binaries re-verify in place, an installed service is
 * skipped, and an already-joined node (a resolvable 100.64 IP) skips the one-time
 * key mint + join. So a crash between any two steps is recovered by simply
 * re-running `host enable`.
 *
 * PRIVILEGE, precisely (Overlay Coexistence spec C1/C2): tailscaled runs
 * UNPRIVILEGED — a user-domain service in userspace-networking mode on its own
 * private socket and statedir, adopting the member overlay's proven shape. Root
 * is still required for ONE named reason: headscale is supervised as a SYSTEM
 * service so the control plane survives reboot-before-login, and its admin
 * socket is root-owned (key minting, node listing). Root is surfaced up front,
 * never smuggled, and each privileged step shells `sudo` through the runner seam.
 *
 * Note the honest limit on that justification: the Myco daemon itself is
 * user-domain, and nothing here enables systemd lingering, so a host is not
 * actually reachable before login regardless of headscale's domain.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { createHostId } from '@myco/grove/ids.js';
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';
import {
  resolveHostControlDir,
  resolveHostTailscaledSocketPath,
  resolveHostTailscaledStateDir,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import { assertSocketPathFits } from '@myco/host/member-overlay.js';
import { allocateHostServeOverlayPort } from '@myco/host/registry.js';
import { createTailscaleCli, type TailscaleCli } from '@myco/host/tailscale-cli.js';
import { readServeTcpForwards, readServeTcpPorts, retireOverlayForward } from '@myco/daemon/overlay-forward.js';
import { loadMachineConfig } from '@myco/config/loader.js';
import { createGrove, ensureDefaultGrove, loadGroveRecord, resolveDefaultGrove } from '@myco/grove/registry.js';
import { seedGroveBackupDefaults } from '@myco/backup/service.js';
import { getServiceManager } from '@myco/service/manager.js';
import type { ServiceManager } from '@myco/service/types.js';

import {
  provisionOverlayBinaries,
  realFetcher,
  resolveOverlayTarget,
  type BinaryFetcher,
  type CommandRunner,
} from './binaries.js';
import type { ServiceSpec } from '@myco/service/types.js';
import { headscaleLayout, mintPreauthKey, renderHeadscaleConfig } from './headscale-config.js';
import { realRunner } from './run.js';
import { restartDaemonForHostServe, writeHostServeConfig } from './daemon-apply.js';
import { clearHostState, readHostState, writeHostState } from './state.js';
import {
  buildOverlayServiceSpec,
  checkRootAvailable,
  installSystemService,
  isSystemServiceInstalled,
  uninstallSystemService,
  HEADSCALE_SERVICE_LABEL,
  type SystemServiceContext,
} from './system-service.js';

/**
 * THIS machine's host-role userspace-tailscaled service label — Myco-owned on
 * every platform (Overlay Coexistence spec C1). Distinct from the member's
 * per-host `co.goondocks.myco-member-tailscaled.<tag>`, so a box that both
 * serves and joins runs both without either supervisor seeing the other.
 *
 * The vendor macOS label this file used to name (`com.tailscale.tailscaled`) is
 * GONE, along with the root daemon that used it: pointing Myco's supervisor at
 * the vendor label meant two supervisors fighting over one state file and one
 * socket, and a Myco teardown that could uninstall the user's own Tailscale.
 */
const HOST_TAILSCALED_LABEL = 'co.goondocks.myco-host-tailscaled';

/**
 * The label of the LEGACY root tailscaled unit this host used to install on
 * Linux. Retained for teardown ONLY — `host disable` still removes it so an
 * upgraded pre-C1 rig converges. Safe to touch because the label was always
 * Myco-owned; the vendor's STATE files are deliberately left alone, since
 * deleting `/var/lib/tailscale` is indistinguishable from deleting a genuine
 * vendor install's.
 */
const LEGACY_TAILSCALED_LINUX_LABEL = 'co.goondocks.myco-tailscaled';

export interface HostEnableOptions {
  /** REQUIRED — the address members dial to reach the control plane (e.g. `https://host.example:8080`). */
  serverUrl: string;
  /** Host node name on the tailnet. Default: sanitized `os.hostname()`. */
  hostname?: string;
  /** Where headscale binds locally. Default `0.0.0.0:8080`. */
  listenAddr?: string;
  /** Headscale user owning the host + member nodes. Default `myco-host`. */
  headscaleUser?: string;
  /** One-time pre-auth key lifetime. Default `1h`. */
  keyExpiration?: string;
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
   * Default: `'default'`.
   */
  groveDesignation?: 'default' | 'fresh';
}

export interface HostEnableDeps {
  fetcher?: BinaryFetcher;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  mycoHome?: string;
  serviceManager?: ServiceManager;
  /** Overrides for the system-service dirs (tests inject temp dirs). */
  systemCtx?: Partial<SystemServiceContext>;
  brewBinDirs?: string[];
  /** Resolve the host's assigned 100.64/10 overlay IP from tailscale. */
  resolveOverlayIp?: (cli: TailscaleCli) => Promise<string | null>;
  /** Override THIS machine's host tailscaled socket path (tests inject a short temp path). */
  hostTailscaledSocketPath?: string;
  /** Override THIS machine's host tailscaled statedir (tests inject a temp dir). */
  hostTailscaledStateDir?: string;
  /** Wait for the freshly-installed tailscaled to bind its control socket. */
  waitForSocket?: (socketPath: string) => Promise<boolean>;
  /** Pin the overlay listener port (tests); production allocates it. */
  overlayPort?: number;
  /** Resolve the headscale node id for the host node (best-effort). */
  resolveNodeId?: (runner: CommandRunner, headscaleBin: string, configPath: string, hostname: string) => Promise<string | undefined>;
  /** Best-effort probe that the daemon overlay listener came up. Never fatal. */
  verifyOverlayListener?: (address: string, mycoHome: string) => Promise<boolean>;
  logger?: (message: string) => void;
}

export interface HostEnableResult {
  hostId: string;
  overlayAddress: string;
  /** The port members dial — `overlayAddress:overlayPort` is the full address. */
  overlayPort: number;
  serverUrl: string;
  headscaleVersion: string;
  tailscaleVersion: string;
  daemonRestarted: boolean;
  overlayListenerUp: boolean;
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
function createOrAdoptFreshServedGrove(mycoHome: string, controlDir: string, log: (message: string) => void): string {
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
  const grove = createGrove('Team Host', mycoHome);
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
): { groveId: string; warning?: string } {
  if (existingServedGroveId) {
    const grove = loadGroveRecord(existingServedGroveId, mycoHome);
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
    return { groveId: createOrAdoptFreshServedGrove(mycoHome, controlDir, log) };
  }
  return { groveId: ensureDefaultGrove(mycoHome).id };
}

/** How long to wait for a freshly-installed host tailscaled to bind its control
 *  socket before failing loudly. Mirrors the member's own start-up race budget. */
export const HOST_TAILSCALED_SOCKET_TIMEOUT_MS = 5000;

/**
 * Build the {@link ServiceSpec} for THIS machine's host-role tailscaled — an
 * unprivileged user-domain service, mirroring `buildMemberTailscaledSpec`.
 * `--tun=userspace-networking` (no kernel TUN, no privilege, no route claim), a
 * private `--socket`, a private `--statedir`, and a Myco-owned label.
 *
 * No `--outbound-http-proxy-listen`: unlike a member, the host only ACCEPTS
 * overlay connections — it never dials one.
 */
export function buildHostTailscaledSpec(input: {
  executable: string;
  socketPath: string;
  stateDir: string;
  workingDir: string;
  logDir: string;
}): ServiceSpec {
  return {
    label: HOST_TAILSCALED_LABEL,
    variant: 'prod',
    executable: input.executable,
    args: [
      '--tun=userspace-networking',
      `--socket=${input.socketPath}`,
      `--statedir=${input.stateDir}`,
    ],
    workingDir: input.workingDir,
    env: {},
    stdoutPath: path.join(input.logDir, `${HOST_TAILSCALED_LABEL}.out.log`),
    stderrPath: path.join(input.logDir, `${HOST_TAILSCALED_LABEL}.err.log`),
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
  };
}

/** Poll for the host tailscaled socket to appear, bounded by
 *  {@link HOST_TAILSCALED_SOCKET_TIMEOUT_MS}. */
async function defaultWaitForHostSocket(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + HOST_TAILSCALED_SOCKET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fs.existsSync(socketPath);
}

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

export async function hostEnable(options: HostEnableOptions, deps: HostEnableDeps = {}): Promise<HostEnableResult> {
  if (!options.serverUrl?.trim()) {
    throw new Error('host enable requires --server-url <https://host:8080> — the address members dial to reach the control plane.');
  }
  const log = deps.logger ?? ((m: string) => console.log(m));
  const notes: string[] = [];
  const runner = deps.runner ?? realRunner;
  const fetcher = deps.fetcher ?? realFetcher;
  const platform = deps.platform ?? process.platform;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const target = resolveOverlayTarget(platform, deps.arch ?? process.arch);
  const ctx: SystemServiceContext = { runner, platform, logger: log, ...deps.systemCtx };
  const hostname = sanitizeHostname(options.hostname ?? os.hostname());
  const headscaleUser = options.headscaleUser ?? 'myco-host';

  // Surface the root requirement up front — never smuggle credentials.
  const root = await checkRootAvailable(ctx);
  if (!root.available) {
    log(`NOTE: ${root.detail}`);
    notes.push(root.detail);
  } else {
    log('root: sudo available for the headscale system-service install (tailscaled runs unprivileged).');
  }

  // 1. Provision binaries (idempotent — re-verifies in place).
  log(`Provisioning overlay binaries for ${target.os}/${target.arch}…`);
  const bins = await provisionOverlayBinaries({
    target, fetcher, runner, brewBinDirs: deps.brewBinDirs, logger: log,
  });

  // 2. Generate headscale config + state dir.
  const controlDir = resolveHostControlDir();
  const layout = headscaleLayout(controlDir);
  fs.mkdirSync(layout.stateDir, { recursive: true });
  fs.mkdirSync(path.join(layout.stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(layout.configPath, renderHeadscaleConfig({
    serverUrl: options.serverUrl.trim(),
    listenAddr: options.listenAddr ?? '0.0.0.0:8080',
    layout,
  }), 'utf-8');
  log(`Wrote headscale config: ${layout.configPath}`);

  // 3. Supervise headscale as a ROOT service (the reboot lesson — never nohup).
  const headscaleSpec = buildOverlayServiceSpec({
    label: HEADSCALE_SERVICE_LABEL,
    description: 'Myco Team Host control plane (headscale)',
    executable: bins.headscaleBin,
    args: ['serve', '--config', layout.configPath],
    workingDir: layout.stateDir,
    logDir: path.join(layout.stateDir, 'logs'),
  });
  if (isSystemServiceInstalled(ctx, HEADSCALE_SERVICE_LABEL)) {
    log('headscale service already installed — skipping.');
  } else {
    await installSystemService(ctx, headscaleSpec);
    log('headscale supervised as a root service.');
  }

  // 4. Supervise tailscaled as an UNPRIVILEGED user-domain service on its own
  //    private socket + statedir (coexistence C1/C2). No sudo, no TUN, no
  //    vendor path — the member overlay's proven shape, not a second design.
  const serviceManager = deps.serviceManager ?? getServiceManager({ platform });
  const tailscaledSocket = deps.hostTailscaledSocketPath ?? resolveHostTailscaledSocketPath();
  const tailscaledStateDir = deps.hostTailscaledStateDir ?? resolveHostTailscaledStateDir();
  assertSocketPathFits(tailscaledSocket, platform);
  fs.mkdirSync(tailscaledStateDir, { recursive: true });
  if (await serviceManager.inspect(HOST_TAILSCALED_LABEL)) {
    log('host tailscaled already supervised — skipping.');
  } else {
    await serviceManager.install(buildHostTailscaledSpec({
      executable: bins.tailscaledBin,
      socketPath: tailscaledSocket,
      stateDir: tailscaledStateDir,
      workingDir: layout.stateDir,
      logDir: path.join(layout.stateDir, 'logs'),
    }));
    log(`host tailscaled supervised unprivileged as ${HOST_TAILSCALED_LABEL} (userspace, ${tailscaledSocket}).`);
  }
  const tailscaleCli = createTailscaleCli({
    runner,
    tailscaleBin: bins.tailscaleBin,
    socketPath: tailscaledSocket,
  });
  // A freshly-installed agent needs a moment to bind its socket before any
  // `tailscale` call can reach it — the same start→up race the member already
  // pays for (`member-overlay.ts`), and on a reboot it is the LIKELY ordering.
  const socketReady = await (deps.waitForSocket ?? defaultWaitForHostSocket)(tailscaledSocket);
  if (!socketReady) {
    throw new Error(
      `host tailscaled did not bind its control socket at ${tailscaledSocket} within `
      + `${HOST_TAILSCALED_SOCKET_TIMEOUT_MS}ms. Check the service logs under ${path.join(layout.stateDir, 'logs')} and re-run \`myco host enable\`.`,
    );
  }

  // Reconcile stale forwards BEFORE joining — but never the live one.
  //
  //    The serve config is durable across tailscaled restarts, so a forward
  //    that survived a failed `host disable` is resurrected the instant
  //    tailscaled starts here. Retiring ALL of them, though, cuts the forward
  //    of a daemon that is currently serving — and `host enable` is documented
  //    as re-runnable to converge, so that is the ordinary case, not an exotic
  //    one. It would also report success: the listener probe hits
  //    `127.0.0.1:P`, which the still-running daemon still holds.
  //
  //    So allocate the port FIRST (idempotent) and drop only the others.
  const overlayPort = deps.overlayPort ?? allocateHostServeOverlayPort(mycoHome);
  await (async () => {
    try {
      for (const stale of await readServeTcpForwards(tailscaleCli)) {
        if (stale.port === overlayPort) continue;
        await retireOverlayForward(tailscaleCli, stale.port);
        log(`retired a stale overlay forward on port ${stale.port} from a previous run.`);
      }
    } catch (err) {
      notes.push(`could not check for stale overlay forwards: ${(err as Error).message}`);
    }
  })();

  // 5. Join the host node — but only if it isn't already on the tailnet
  //    (idempotent: a re-run with an already-used one-time key would fail).
  const resolveIp = deps.resolveOverlayIp ?? ((cli: TailscaleCli) => cli.overlayIp());
  let overlayAddress = await resolveIp(tailscaleCli);
  if (overlayAddress) {
    log(`host node already on the overlay at ${overlayAddress} — skipping join.`);
  } else {
    log('Minting a one-time pre-auth key + joining the host node…');
    const key = await mintPreauthKey({
      headscaleBin: bins.headscaleBin,
      configPath: layout.configPath,
      user: headscaleUser,
      expiration: options.keyExpiration ?? '1h',
      runner,
    });
    // Unprivileged: the private socket is user-owned, so `up` needs no sudo.
    const up = await tailscaleCli.run([
      'up',
      '--login-server', options.serverUrl.trim(),
      '--auth-key', key,
      '--hostname', hostname,
    ]);
    if (up.exitCode !== 0) {
      throw new Error(`\`tailscale up\` failed (exit ${up.exitCode}): ${up.stdout.trim()}`);
    }
    overlayAddress = await resolveIp(tailscaleCli);
  }

  if (!overlayAddress || !isOverlayRangeAddress(overlayAddress)) {
    throw new Error(
      `Could not resolve a 100.64.0.0/10 overlay IP for the host node (got ${JSON.stringify(overlayAddress)}). `
      + 'The tailnet join may not have completed — check `tailscale status` and re-run host enable.',
    );
  }
  log(`Host overlay IP: ${overlayAddress}`);

  // 6. Resolve served-grove designation (create-or-reuse, immutable once
  //    set — server-mode design spec §2), THEN wire the daemon: write
  //    machine-tier host_serve + restart to bind the listener. Resolve the
  //    durable host_id up front (reused for the state record in step 7) so
  //    the daemon's enrollment endpoint (Task 2.4) can self-report id +
  //    label to joining members. `hostname` is the host's tailnet node
  //    name — the label.
  const existingServedGroveId = loadMachineConfig(mycoHome).daemon.host_serve.served_grove_id ?? undefined;
  const designation = resolveServedGroveDesignation(
    options.groveDesignation ?? 'default',
    existingServedGroveId,
    mycoHome,
    controlDir,
    log,
  );
  if (designation.warning) notes.push(designation.warning);

  const existingState = readHostState();
  const hostId = existingState?.host_id ?? createHostId();
  // `overlayPort` was allocated before the forward reconcile above — from the
  // ONE allocator that owns this machine's loopback ports, so a later
  // `myco join` on this box cannot hand a member the port we serve on.
  // Idempotent: a re-run keeps the port members already recorded.
  writeHostServeConfig({
    enabled: true,
    overlayAddress,
    overlayPort,
    hostId,
    label: hostname,
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
  const restart = await restartDaemonForHostServe(mycoHome, deps.serviceManager ?? getServiceManager());
  log(restart.detail);
  if (!restart.restarted) {
    // Load-bearing, not informational: the daemon wires the inbound forward
    // only when it binds. If it did not restart, nothing re-wires, and this
    // host stays unreachable to members until it does.
    const warning = `${restart.detail} The overlay forward is wired when the daemon binds, so this host `
      + 'is NOT reachable by members until the daemon restarts. Restart it, then re-run `myco host enable`.';
    log(`WARNING: ${warning}`);
    notes.push(warning);
  }

  // 7. Resolve node id (best-effort) + record host state.
  const nodeId = deps.resolveNodeId
    ? await deps.resolveNodeId(runner, bins.headscaleBin, layout.configPath, hostname)
    : await defaultResolveNodeId(runner, bins.headscaleBin, layout.configPath, hostname);

  writeHostState({
    host_id: hostId,
    enabled_at: existingState?.enabled_at ?? new Date().toISOString(),
    server_url: options.serverUrl.trim(),
    overlay_address: overlayAddress,
    node_id: nodeId,
    headscale_user: headscaleUser,
    headscale_version: bins.headscaleVersion,
    tailscale_version: bins.tailscaleVersion,
    platform,
    headscale_bin: bins.headscaleBin,
    tailscale_bin: bins.tailscaleBin,
    tailscaled_bin: bins.tailscaledBin,
  });

  // 8. Best-effort verify the overlay listener came up (never fatal).
  const verify = deps.verifyOverlayListener ?? defaultVerifyOverlayListener;
  const overlayListenerUp = await verify(overlayAddress, mycoHome).catch(() => false);
  log(overlayListenerUp
    ? `Overlay listener responding on ${overlayAddress}.`
    : 'Overlay listener not confirmed yet — verify with the live checklist after the daemon settles.');

  return {
    hostId,
    overlayAddress,
    overlayPort,
    serverUrl: options.serverUrl.trim(),
    headscaleVersion: bins.headscaleVersion,
    tailscaleVersion: bins.tailscaleVersion,
    daemonRestarted: restart.restarted,
    overlayListenerUp,
    servedGroveId: designation.groveId,
    notes,
  };
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
 * Tear down host serving: clear config + restart the daemon (so it unbinds the
 * overlay listener), then stop + uninstall both services and remove state.
 * Idempotent and safe when only partially enabled — every step tolerates an
 * already-absent resource, so a retry after a partial failure converges.
 */
export async function hostDisable(deps: HostEnableDeps = {}): Promise<HostDisableResult> {
  const log = deps.logger ?? ((m: string) => console.log(m));
  const runner = deps.runner ?? realRunner;
  const platform = deps.platform ?? process.platform;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const ctx: SystemServiceContext = { runner, platform, logger: log, ...deps.systemCtx };
  const state = readHostState();
  const errors: string[] = [];

  const step = async (label: string, run: () => Promise<void>): Promise<void> => {
    try { await run(); } catch (err) { errors.push(`${label}: ${(err as Error).message}`); }
  };

  // 0. Retire the inbound forward FIRST — before the config clear, and by
  //    ENUMERATION rather than by the configured port.
  //
  //    Reading the port from config and retiring later cannot converge: the
  //    clear nulls `overlay_port`, so if the retire then fails, every retry
  //    sees null, skips the retire entirely, uninstalls tailscaled and drops
  //    the recorded binary path — leaving a durable forward that no code path
  //    can ever remove. Enumerating asks tailscaled what actually exists, so a
  //    retry converges and a forward from an EARLIER port is caught too.
  if (state?.tailscale_bin) {
    await step('retire overlay forwards', async () => {
      const cli = createTailscaleCli({
        runner,
        tailscaleBin: state.tailscale_bin,
        socketPath: deps.hostTailscaledSocketPath ?? resolveHostTailscaledSocketPath(),
      });
      for (const port of await readServeTcpPorts(cli)) {
        await retireOverlayForward(cli, port);
        log(`retired the overlay forward on port ${port}.`);
      }
    });
  }

  // 1. Clear host_serve and restart, so the daemon stops serving before the
  //    overlay is torn out from under it.
  let daemonRestarted = false;
  await step('clear host_serve config', async () => {
    writeHostServeConfig({ enabled: false, overlayAddress: null }, mycoHome);
  });
  await step('restart daemon', async () => {
    const r = await restartDaemonForHostServe(mycoHome, deps.serviceManager ?? getServiceManager());
    daemonRestarted = r.restarted;
    log(r.detail);
  });

  // 2. Tear down tailscaled.
  const tailscaledBin = state?.tailscaled_bin ?? 'tailscaled';
  await step('uninstall tailscaled', async () => {
    await (deps.serviceManager ?? getServiceManager({ platform })).uninstall(HOST_TAILSCALED_LABEL);
    // Converge an upgraded pre-C1 rig: the legacy ROOT unit was Myco-labeled,
    // so removing it is safe. Its vendor-path STATE is deliberately left alone
    // — deleting /var/lib/tailscale is indistinguishable from deleting a
    // genuine vendor install's state.
    if (platform === 'linux' && isSystemServiceInstalled(ctx, LEGACY_TAILSCALED_LINUX_LABEL)) {
      await uninstallSystemService(ctx, LEGACY_TAILSCALED_LINUX_LABEL);
      log('removed the legacy root tailscaled unit from a pre-coexistence install.');
    }
  });

  // 3. Tear down headscale.
  await step('uninstall headscale', async () => {
    await uninstallSystemService(ctx, HEADSCALE_SERVICE_LABEL);
  });

  // 4. Remove headscale state + host state record (keep the binary cache — cheap
  //    to keep, speeds a later re-enable; it holds no secrets).
  await step('remove headscale state', async () => {
    const layout = headscaleLayout(resolveHostControlDir());
    fs.rmSync(layout.stateDir, { recursive: true, force: true });
  });
  await step('clear host state', async () => { clearHostState(); });

  if (errors.length > 0) {
    log(`host disable completed with ${errors.length} issue(s); local host-serve is off.`);
  } else {
    log('Team Host disabled: services stopped + removed, host-serve off.');
  }
  return { cleared: errors.length === 0, errors, daemonRestarted };
}

// ---------------------------------------------------------------------------
// Default seams
// ---------------------------------------------------------------------------


/** `headscale nodes list --output json` → the id of the node matching `hostname`.
 *  The admin socket is root-owned, so the call is sudo'd (same as key minting). */
async function defaultResolveNodeId(
  runner: CommandRunner,
  headscaleBin: string,
  configPath: string,
  hostname: string,
): Promise<string | undefined> {
  try {
    const res = await runner.run('sudo', [headscaleBin, '--config', configPath, 'nodes', 'list', '--output', 'json']);
    if (res.exitCode !== 0) return undefined;
    const parsed = JSON.parse(res.stdout) as Array<{ id?: unknown; name?: unknown; given_name?: unknown }>;
    const match = parsed.find((n) => n.name === hostname || n.given_name === hostname);
    return match?.id !== undefined ? String(match.id) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort overlay-listener probe: read the running daemon's port from
 * `daemon.json` and issue one short request to the overlay address. Any HTTP
 * response (even a 401 from the bearer gate) proves the listener is bound; a
 * connection error means it isn't up yet. Never throws — the live checklist is
 * the authoritative verification.
 */
async function defaultVerifyOverlayListener(_address: string, mycoHome: string): Promise<boolean> {
  try {
    // LOOPBACK, and the OVERLAY port — not the overlay address and not the
    // daemon's canonical port. Post-C1 there is no TUN, so the host has no
    // route to its own 100.64 address (measured: the dial times out), and the
    // listener binds `127.0.0.1:overlay_port`. Probing the old pair reported
    // every healthy host as unconfirmed. End-to-end overlay reachability is a
    // member-side fact (X1–X3), not something the host can self-check.
    const port = loadMachineConfig(mycoHome).daemon.host_serve.overlay_port;
    if (!port) return false;
    const address = '127.0.0.1';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(`http://${address}:${port}/health`, { signal: controller.signal });
      return true; // any response (incl. 401) means the listener is bound
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Reduce an arbitrary hostname to a tailnet-safe label. */
function sanitizeHostname(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'myco-host';
}

/** Expose the tailscaled service labels for callers/tests. */
export { HOST_TAILSCALED_LABEL, LEGACY_TAILSCALED_LINUX_LABEL };
