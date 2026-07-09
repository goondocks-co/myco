/**
 * Operator control plane (Task 2.4) — key minting + Devices (list / evict) +
 * bearer rotation, wrapping the headscale CLI behind the {@link CommandRunner}
 * seam so it unit-tests with no real control plane.
 *
 * These are the OPERATOR/MEMBER trust boundary in the flesh: they run ONLY as the
 * `myco-team host` CLI on the host's localhost (spec §8 — "Operator (host localhost):
 * the control plane, exclusively"). They are NOT daemon routes and are never served
 * over the overlay, so a member (who reaches only the daemon's overlay listener)
 * structurally cannot mint keys or evict devices — the localhost trust boundary is
 * reused, not re-implemented as RBAC. Eviction = overlay device removal, the v1
 * revocation lever (spec §8: "Eviction = overlay device removal — immediate network
 * cut"). Every mutating op appends to the control-plane action log (never a secret).
 */
import { isOverlayRangeAddress, rotateHostServeBearer } from '@myco/daemon/host-serve.js';
import { appendHostAction } from '@myco/host/action-log.js';
import { resolveHostControlDir, resolveMycoHome } from '@myco/grove/paths.js';
import { getServiceManager } from '@myco/service/manager.js';
import type { ServiceManager } from '@myco/service/types.js';

import type { CommandRunner } from './binaries.js';
import { headscaleLayout, mintPreauthKey } from './headscale-config.js';
import { realRunner } from './run.js';
import { restartDaemonForHostServe } from './daemon-apply.js';
import { readHostState, type HostState } from './state.js';

/** Seams every control-plane op shares. Defaults are the real implementations. */
export interface ControlPlaneDeps {
  runner?: CommandRunner;
  /** The host state (headscale bin, config path, user). Default: on-disk state. */
  state?: HostState | null;
  /** The host-control home (action log + headscale layout). Default: machine-global. */
  controlDir?: string;
}

/** Thrown when a control-plane op runs on a machine that is not a Team Host. */
export class NotAHostError extends Error {
  constructor() {
    super('This machine is not a Team Host — run `myco-team host enable` first.');
    this.name = 'NotAHostError';
  }
}

/** Resolve the headscale invocation base (bin + config) from host state, or throw. */
function headscaleBase(deps: ControlPlaneDeps): { bin: string; configPath: string; user: string; controlDir: string } {
  const controlDir = deps.controlDir ?? resolveHostControlDir();
  const state = deps.state === undefined ? readHostState() : deps.state;
  if (!state) throw new NotAHostError();
  return {
    bin: state.headscale_bin,
    configPath: headscaleLayout(controlDir).configPath,
    user: state.headscale_user,
    controlDir,
  };
}

// ---------------------------------------------------------------------------
// key mint
// ---------------------------------------------------------------------------

/**
 * Mint a ONE-TIME setup key for the operator to hand a joiner (spec §8). Wraps
 * Task 2.1's {@link mintPreauthKey} (`headscale preauthkeys create`). Logs the mint
 * (user + expiration) — NEVER the key value.
 */
export async function mintSetupKey(
  options: { expiration?: string } = {},
  deps: ControlPlaneDeps = {},
): Promise<string> {
  const base = headscaleBase(deps);
  const runner = deps.runner ?? realRunner;
  const expiration = options.expiration ?? '1h';
  const key = await mintPreauthKey({
    headscaleBin: base.bin,
    configPath: base.configPath,
    user: base.user,
    expiration,
    runner,
  });
  appendHostAction({ action: 'key-mint', subject: base.user, detail: { expiration } }, base.controlDir);
  return key;
}

// ---------------------------------------------------------------------------
// devices list / evict
// ---------------------------------------------------------------------------

export interface Device {
  /** Headscale node id — the argument `devices evict <id>` takes. */
  id: string;
  /** Node name (`given_name` preferred — the tailnet-visible name). */
  name: string;
  /** The node's overlay IP (the 100.64/10 address if present, else the first). */
  overlay_ip: string | null;
  /** Last-seen timestamp as headscale reports it (RFC3339 string), or null. */
  last_seen: string | null;
  online: boolean;
}

/** List enrolled overlay nodes (`headscale nodes list --output json`, pinned v0.29). */
export async function listDevices(deps: ControlPlaneDeps = {}): Promise<Device[]> {
  const base = headscaleBase(deps);
  const runner = deps.runner ?? realRunner;
  const res = await runner.run(base.bin, ['--config', base.configPath, 'nodes', 'list', '--output', 'json']);
  if (res.exitCode !== 0) {
    throw new Error(`headscale nodes list failed (exit ${res.exitCode}): ${res.stdout.trim()}`);
  }
  return parseNodesList(res.stdout);
}

/**
 * Evict a device: `headscale nodes delete -i <id> --force` (pinned v0.29). Cuts the
 * overlay node immediately (spec §8 — "immediate network cut"), which is the v1
 * revocation lever. Logs the eviction (subject = node id).
 */
export async function evictDevice(id: string, deps: ControlPlaneDeps = {}): Promise<void> {
  if (!id?.trim()) throw new Error('evict requires a device <id> (from `myco-team host devices list`).');
  const base = headscaleBase(deps);
  const runner = deps.runner ?? realRunner;
  const res = await runner.run(base.bin, ['--config', base.configPath, 'nodes', 'delete', '-i', id.trim(), '--force']);
  if (res.exitCode !== 0) {
    throw new Error(`headscale nodes delete -i ${id} failed (exit ${res.exitCode}): ${res.stdout.trim()}`);
  }
  appendHostAction({ action: 'evict', subject: id.trim() }, base.controlDir);
}

/** Parse `headscale nodes list --output json` into {@link Device}s. Accepts both the
 *  bare-array and `{nodes:[…]}`-wrapped shapes v0.29 has shipped; skips malformed rows. */
export function parseNodesList(json: string): Device[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const nodes = Array.isArray(parsed) ? parsed : (parsed as { nodes?: unknown[] })?.nodes;
  if (!Array.isArray(nodes)) return [];
  const devices: Device[] = [];
  for (const n of nodes) {
    const rec = n as {
      id?: unknown; name?: unknown; given_name?: unknown;
      ip_addresses?: unknown; last_seen?: unknown; online?: unknown;
    };
    const id = rec.id === undefined || rec.id === null ? '' : String(rec.id);
    if (!id) continue;
    const ips = Array.isArray(rec.ip_addresses) ? rec.ip_addresses.filter((v): v is string => typeof v === 'string') : [];
    const overlayIp = ips.find((ip) => isOverlayRangeAddress(ip)) ?? ips[0] ?? null;
    devices.push({
      id,
      name: (typeof rec.given_name === 'string' && rec.given_name) || (typeof rec.name === 'string' ? rec.name : ''),
      overlay_ip: overlayIp,
      last_seen: typeof rec.last_seen === 'string' ? rec.last_seen : null,
      online: rec.online === true,
    });
  }
  return devices;
}

// ---------------------------------------------------------------------------
// bearer rotate
// ---------------------------------------------------------------------------

export interface BearerRotateResult {
  /** True when the daemon was restarted so the new bearer takes effect. */
  daemonRestarted: boolean;
  detail: string;
}

/**
 * Rotate the shared host bearer (spec §8 — the single v1 revocation lever for the
 * bearer itself). Overwrites the machine secret, restarts the daemon so it re-reads
 * it, and logs the rotation. BLAST RADIUS: every member is now unauthenticated and
 * must re-join — the caller MUST warn the operator. Does not print the new bearer
 * (members receive it via enrollment, never out-of-band).
 */
export async function rotateBearer(
  deps: ControlPlaneDeps & { mycoHome?: string; serviceManager?: ServiceManager } = {},
): Promise<BearerRotateResult> {
  const controlDir = deps.controlDir ?? resolveHostControlDir();
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  rotateHostServeBearer(mycoHome);
  const restart = await restartDaemonForHostServe(mycoHome, deps.serviceManager ?? getServiceManager());
  appendHostAction({ action: 'rotate', detail: { daemon_restarted: restart.restarted } }, controlDir);
  return { daemonRestarted: restart.restarted, detail: restart.detail };
}
