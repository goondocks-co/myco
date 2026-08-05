/**
 * Host state record — the durable "this machine is a Team Host" marker at
 * `~/.myco-team/host/state.json`. It carries only the identity a host keeps
 * across enables: its `host_id`, when it was first enabled, and the label
 * members see.
 *
 * A host runs no processes of its own and provisions no binaries — it serves a
 * socket the daemon already owns — so disable has nothing here to consult
 * beyond the identity itself.
 *
 * Pure disk read/write, atomic temp+rename (same discipline as the team/host
 * registries). No secrets live here — the host bearer stays in the machine
 * `secrets.env` ({@link resolveHostServeBearer}).
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveHostControlDir } from '@myco/grove/paths.js';

export interface HostState {
  host_id: string;
  enabled_at: string;
  /** Host node label surfaced to members at enrollment. */
  label?: string;
  platform: string;
  /**
   * The public URL this host currently serves, learned from the tailnet at
   * Funnel activation and re-verified at every boot. NOT operator-configured:
   * the name is `<machine>.<tailnet>.ts.net`, which only Tailscale knows and
   * which changes if either is renamed — so it is recorded here as an
   * observation, and the boot that observes something different overwrites it.
   * Absent until the first successful activation.
   */
  host_url?: string;
  /** Why the last activation attempt did not publish a URL, when it did not.
   *  Kept so the Team page can explain an unreachable host instead of showing
   *  a blank address. Cleared on success. */
  funnel_error?: string;
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
