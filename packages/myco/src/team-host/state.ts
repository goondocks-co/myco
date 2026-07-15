/**
 * Host state record (Task 2.1) — the durable "this machine is a Team Host"
 * marker at `~/.myco-team/host/state.json`. Records version provenance, the
 * assigned overlay IP, the headscale node/user, and the provisioned binary
 * paths so a re-run of `host enable` can converge (each step checks already-done)
 * and `host disable` knows exactly what to tear down.
 *
 * Pure disk read/write, atomic temp+rename (same discipline as the team/host
 * registries). No secrets live here — the host bearer stays in the machine
 * `secrets.env` (Task 2.3's `resolveHostServeBearer`).
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveHostControlDir } from '@myco/grove/paths.js';

export interface HostState {
  host_id: string;
  enabled_at: string;
  /** The address members dial to reach the control plane (`server_url`). */
  server_url: string;
  /** The host's assigned 100.64/10 overlay IP (what the daemon overlay listener binds). */
  overlay_address: string;
  /** Headscale node id for the host node, once resolved. */
  node_id?: string;
  headscale_user: string;
  headscale_version: string;
  tailscale_version: string;
  platform: string;
  headscale_bin: string;
  tailscale_bin: string;
  tailscaled_bin: string;
}

export function hostStatePath(): string {
  return path.join(resolveHostControlDir(), 'state.json');
}

/** Read the host state record, or null when this machine is not a host. */
export function readHostState(): HostState | null {
  try {
    return JSON.parse(fs.readFileSync(hostStatePath(), 'utf-8')) as HostState;
  } catch {
    return null;
  }
}

/** Create or overwrite the host state record (atomic temp+rename). */
export function writeHostState(state: HostState): void {
  const dir = resolveHostControlDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = hostStatePath();
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, dest);
}

/** Remove the host state record. No-op when absent. */
export function clearHostState(): void {
  fs.rmSync(hostStatePath(), { force: true });
}
