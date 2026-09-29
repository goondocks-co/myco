/**
 * The settings a Deployment holds for this machine (#1393), as this machine caches them: one file per Deployment,
 * beside its membership, written whenever the Deployment answers them (session start, `/members/settings`) and read
 * by the hooks without a request. Offline, the last answer stands; with none, every leaf is at its default.
 *
 * An answer that carries no settings leaves the file as it is: a credential that joined no machine is told nothing,
 * and that is not an instruction to forget what this machine was told before.
 */
import fs from 'node:fs';
import { resolveMycoHome } from '../paths/home.js';
import { deploymentsDir, machineSettingsPath } from './registry.js';
import { ensureMemberDir, readPrivateJson, writePrivateFileAtomic } from './store.js';
import { CONNECT_TIMEOUT_CAP_MS } from './constants.js';
import { ServerClient, type FetchLike } from './transport.js';

/** The leaf naming the folders this machine's agents write plans to, beyond the ones each agent's manifest names. */
export const PLAN_DIRS_LEAF = 'capture.plan_dirs';

/** The settings block a Deployment answers, or null when the value is not one. */
export function machineBlockOf(value: unknown): { leaves: Record<string, unknown> } | null {
  if (typeof value !== 'object' || value === null) return null;
  const leaves = (value as { leaves?: unknown }).leaves;
  return typeof leaves === 'object' && leaves !== null && !Array.isArray(leaves) ? { leaves: leaves as Record<string, unknown> } : null;
}

/** Record the settings `serverUrl` answered for this machine. Any other value changes nothing. */
export function cacheMachineSettings(serverUrl: string, answered: unknown, mycoHome: string = resolveMycoHome()): boolean {
  const block = machineBlockOf(answered);
  if (block === null) return false;
  ensureMemberDir(deploymentsDir(mycoHome), mycoHome);
  writePrivateFileAtomic(machineSettingsPath(serverUrl, mycoHome), `${JSON.stringify(block)}\n`);
  return true;
}

/** The extra plan folders `serverUrl` holds for this machine: `~/`, absolute, or relative to each project root. */
export function machinePlanDirs(serverUrl: string, mycoHome: string = resolveMycoHome()): string[] {
  const file = machineSettingsPath(serverUrl, mycoHome);
  if (!fs.existsSync(file)) return [];
  const read = readPrivateJson<unknown>(file);
  const block = read.ok ? machineBlockOf(read.value) : null;
  const dirs = block?.leaves[PLAN_DIRS_LEAF];
  return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string' && d.length > 0) : [];
}

/** Where a Deployment answers its settings, with this machine's own among them. */
export const SETTINGS_READ_PATH = '/members/settings';

/**
 * Ask `serverUrl` for this machine's settings and cache them: what a sign-in, a join and a cutover do, so a machine
 * follows its settings from its first session. A Deployment that does not answer leaves the cache as it was: the
 * next session start asks again.
 */
export async function seedMachineSettings(
  record: { serverUrl: string; token: string }, opts: { mycoHome?: string; fetch?: FetchLike } = {},
): Promise<boolean> {
  try {
    const client = new ServerClient({ serverUrl: record.serverUrl, token: record.token }, opts.fetch ?? globalThis.fetch);
    const raw = await client.request('POST', SETTINGS_READ_PATH, {
      body: '{}', headers: { 'content-type': 'application/json' }, scope: 'deployment',
      budget: { connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS, requestTimeoutMs: SEED_TIMEOUT_MS },
    });
    if (raw.kind !== 'response' || raw.status !== 200 || raw.json === null) return false;
    return cacheMachineSettings(record.serverUrl, raw.json.machine, opts.mycoHome);
  } catch {
    return false;
  }
}

/** How long a sign-in waits for its settings before carrying on without them. */
const SEED_TIMEOUT_MS = 10_000;
