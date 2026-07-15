/**
 * `myco host enable` / `host disable` orchestration.
 *
 * Stands up (or tears down) the OSS overlay — Headscale control plane + Tailscale
 * data plane — as SUPERVISED root services and wires the local daemon to serve
 * over it. Every side effect runs behind an injectable seam ({@link HostEnableDeps})
 * so the whole flow unit-tests with no network, no sudo, and no real service
 * install; the true validation is the LIVE checklist in the task report.
 *
 * IDEMPOTENT / RESUMABLE: a re-run after a partial failure converges. Each step
 * checks already-done — binaries re-verify in place, an installed service is
 * skipped, and an already-joined node (a resolvable 100.64 IP) skips the one-time
 * key mint + join. So a crash between any two steps is recovered by simply
 * re-running `host enable`.
 *
 * ROOT is required and surfaced (never smuggled): the flow reports the sudo
 * requirement up front and each privileged step shells `sudo` through the runner
 * seam, surfacing (not swallowing) a failure.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { createHostId } from '@myco/grove/ids.js';
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';
import { resolveHostControlDir, resolveMycoHome } from '@myco/grove/paths.js';
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
import { headscaleLayout, mintPreauthKey, renderHeadscaleConfig } from './headscale-config.js';
import { realRunner } from './run.js';
import { restartDaemonForHostServe, writeHostServeConfig } from './daemon-apply.js';
import { clearHostState, readHostState, writeHostState } from './state.js';
import {
  buildOverlayServiceSpec,
  checkRootAvailable,
  installSystemService,
  installTailscaledDaemon,
  isSystemServiceInstalled,
  uninstallSystemService,
  uninstallTailscaledDaemon,
  HEADSCALE_SERVICE_LABEL,
  type SystemServiceContext,
} from './system-service.js';

const TAILSCALED_MACOS_LABEL = 'com.tailscale.tailscaled';
const TAILSCALED_LINUX_LABEL = 'co.goondocks.myco-tailscaled';

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
  resolveOverlayIp?: (runner: CommandRunner, tailscaleBin: string) => Promise<string | null>;
  /** Resolve the headscale node id for the host node (best-effort). */
  resolveNodeId?: (runner: CommandRunner, headscaleBin: string, configPath: string, hostname: string) => Promise<string | undefined>;
  /** Best-effort probe that the daemon overlay listener came up. Never fatal. */
  verifyOverlayListener?: (address: string, mycoHome: string) => Promise<boolean>;
  logger?: (message: string) => void;
}

export interface HostEnableResult {
  hostId: string;
  overlayAddress: string;
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
    log('root: sudo available for system-service install.');
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

  // 4. Supervise tailscaled as a ROOT daemon.
  const tailscaledInstalled = platform === 'darwin'
    ? fs.existsSync(path.join(ctx.launchDaemonsDir ?? '/Library/LaunchDaemons', `${TAILSCALED_MACOS_LABEL}.plist`))
    : isSystemServiceInstalled({ ...ctx }, TAILSCALED_LINUX_LABEL);
  if (tailscaledInstalled) {
    log('tailscaled daemon already installed — skipping.');
  } else {
    const linuxSpec = platform === 'linux'
      ? buildOverlayServiceSpec({
        label: TAILSCALED_LINUX_LABEL,
        executable: bins.tailscaledBin,
        args: ['--state', '/var/lib/tailscale/tailscaled.state', '--socket', '/var/run/tailscale/tailscaled.sock'],
        workingDir: layout.stateDir,
        logDir: path.join(layout.stateDir, 'logs'),
      })
      : undefined;
    await installTailscaledDaemon(ctx, bins.tailscaledBin, linuxSpec);
    log('tailscaled supervised as a root daemon.');
  }

  // 5. Join the host node — but only if it isn't already on the tailnet
  //    (idempotent: a re-run with an already-used one-time key would fail).
  const resolveIp = deps.resolveOverlayIp ?? defaultResolveOverlayIp;
  let overlayAddress = await resolveIp(runner, bins.tailscaleBin);
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
    const up = await runner.run('sudo', [
      bins.tailscaleBin, 'up',
      '--login-server', options.serverUrl.trim(),
      '--auth-key', key,
      '--hostname', hostname,
    ]);
    if (up.exitCode !== 0) {
      throw new Error(`\`tailscale up\` failed (exit ${up.exitCode}): ${up.stdout.trim()}`);
    }
    overlayAddress = await resolveIp(runner, bins.tailscaleBin);
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
  writeHostServeConfig({ enabled: true, overlayAddress, hostId, label: hostname, servedGroveId: designation.groveId }, mycoHome);
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
  if (!restart.restarted) notes.push(restart.detail);

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

  // 1. Clear host_serve FIRST and restart, so the daemon stops serving before the
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
    await uninstallTailscaledDaemon(ctx, tailscaledBin, TAILSCALED_LINUX_LABEL);
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

/** `tailscale ip -4` → the first line, iff it is a 100.64/10 address. */
export async function defaultResolveOverlayIp(runner: CommandRunner, tailscaleBin: string): Promise<string | null> {
  const res = await runner.run(tailscaleBin, ['ip', '-4']);
  if (res.exitCode !== 0) return null;
  const line = res.stdout.split('\n').map((l) => l.trim()).find(Boolean);
  return line && isOverlayRangeAddress(line) ? line : null;
}

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
async function defaultVerifyOverlayListener(address: string, mycoHome: string): Promise<boolean> {
  try {
    const statePath = path.join(mycoHome, 'service', 'daemon.json');
    const port = (JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { port?: number }).port;
    if (!port) return false;
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

/** Expose the tailscaled system-daemon labels for callers/tests. */
export { TAILSCALED_MACOS_LABEL, TAILSCALED_LINUX_LABEL };
