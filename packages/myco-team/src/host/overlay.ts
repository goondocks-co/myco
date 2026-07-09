/**
 * `myco-team host enable` / `host disable` orchestration (Task 2.1).
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
  notes: string[];
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

  // 6. Wire the daemon: write machine-tier host_serve + restart to bind the listener.
  //    Resolve the durable host_id up front (reused for the state record in step 7)
  //    so the daemon's enrollment endpoint (Task 2.4) can self-report id + label to
  //    joining members. `hostname` is the host's tailnet node name — the label.
  const existingState = readHostState();
  const hostId = existingState?.host_id ?? createHostId();
  writeHostServeConfig({ enabled: true, overlayAddress, hostId, label: hostname }, mycoHome);
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

/** `headscale nodes list --output json` → the id of the node matching `hostname`. */
async function defaultResolveNodeId(
  runner: CommandRunner,
  headscaleBin: string,
  configPath: string,
  hostname: string,
): Promise<string | undefined> {
  try {
    const res = await runner.run(headscaleBin, ['--config', configPath, 'nodes', 'list', '--output', 'json']);
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
