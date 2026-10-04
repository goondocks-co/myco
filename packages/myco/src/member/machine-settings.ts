/**
 * The settings a Deployment holds for this machine (#1393), as this machine caches them: one file per Deployment,
 * beside its membership, written whenever the Deployment answers them (session start, `/members/settings`) and read
 * by the hooks without a request. Offline, the last answer stands; with none, every leaf is at its default.
 *
 * An answer that carries no settings leaves the file as it is: a credential that joined no machine is told nothing,
 * and that is not an instruction to forget what this machine was told before.
 */
import fs from 'node:fs';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { MACHINE_SETTING_SPECS, MACHINE_SETTINGS_FEATURE, MACHINE_SETTINGS_HEADER, MACHINE_SETTINGS_REVISION_HEADER, MACHINE_SETTINGS_ORDER_HEADER, MACHINE_SETTINGS_INVALIDATED_HEADER, isMachineSettingsRevision, resolveMachineSetting } from '@goondocks/myco-shared/member-protocol';
import { deploymentsDir, machineSettingsPath } from './registry.js';
import { ensureMemberDir, ensurePrivateFile, readPrivateJson, writePrivateFileAtomic } from './store.js';
import { CONNECT_TIMEOUT_CAP_MS } from './constants.js';
import { ServerClient, type FetchLike } from './transport.js';

/** The leaf naming the folders this machine's agents write plans to, beyond the ones each agent's manifest names. */
export const PLAN_DIRS_LEAF = 'capture.plan_dirs';

/** The settings block a Deployment answers, or null when the value is not one. */
export function machineBlockOf(value: unknown): { leaves: Record<string, unknown>; feature?: typeof MACHINE_SETTINGS_FEATURE; revision?: string; invalidated?: true; cachedOrder?: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const leaves = (value as { leaves?: unknown }).leaves;
  if (typeof leaves !== 'object' || leaves === null || Array.isArray(leaves)) return null;
  const block = value as { feature?: unknown; revision?: unknown; invalidated?: unknown; cachedOrder?: unknown };
  return { leaves: leaves as Record<string, unknown>, ...(block.feature === MACHINE_SETTINGS_FEATURE && isMachineSettingsRevision(block.revision) ? { feature: MACHINE_SETTINGS_FEATURE, revision: block.revision } : {}), ...(block.feature === MACHINE_SETTINGS_FEATURE && block.invalidated === true ? { feature: MACHINE_SETTINGS_FEATURE, invalidated: true as const } : {}), ...(typeof block.cachedOrder === 'number' && Number.isSafeInteger(block.cachedOrder) && block.cachedOrder >= 0 ? { cachedOrder: block.cachedOrder } : {}) };
}

interface MachineAnswerOrder { issued: number; received: number }
const ORDER_CLOCK_SCALE = 1_000;
const orderDiagnostics = new Map<string, string>();
const volatileOrders = new Map<string, MachineAnswerOrder>();

/** Allocate a stamp above previous requests and the clock's current millisecond. */
function nextMachineAnswerOrder(order: MachineAnswerOrder): number {
  const stamp = Math.max(order.issued + 1, Date.now() * ORDER_CLOCK_SCALE);
  if (!Number.isSafeInteger(stamp)) throw new Error('Machine settings answer order exhausted.');
  order.issued = stamp;
  return stamp;
}

/** Report an advisory order-file state once until its state changes. */
function orderDiagnostic(orderFile: string, state: string): void {
  const diagnosticFile = `${orderFile}-diagnostic`;
  let changed = orderDiagnostics.get(orderFile) !== state;
  try {
    const read = readPrivateJson<{ state: string }>(diagnosticFile);
    if (state === '' && !read.ok && read.reason === 'missing') {
      orderDiagnostics.set(orderFile, state);
      return;
    }
    changed = read.ok ? read.value?.state !== state : orderDiagnostics.get(orderFile) !== state;
    if (changed || !read.ok) writePrivateFileAtomic(diagnosticFile, `${JSON.stringify({ state })}\n`);
  } catch { /* keep the process-local deduplication when diagnostics cannot be persisted */ }
  orderDiagnostics.set(orderFile, state);
  if (changed && state !== '') process.stderr.write(`[myco] member: machine settings answer order reset (${state}) ${orderFile}\n`);
}

/** The order file only sequences answers; its cached generation survives a damaged sidecar. */
function readMachineAnswerOrder(orderFile: string): { order: MachineAnswerOrder; state: string } {
  let state = '';
  try {
    const stat = fs.lstatSync(orderFile);
    if (!stat.isFile()) state = 'not a regular file';
    else if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) state = 'foreign-owner';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') state = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    else return { order: { issued: 0, received: 0 }, state: '' };
  }
  if (state === '') {
    const read = readPrivateJson<MachineAnswerOrder>(orderFile);
    if (!read.ok) state = read.reason === 'unreadable' ? `${read.reason}:${read.detail ?? 'unknown'}` : read.reason;
    else if (read.value === null || typeof read.value !== 'object'
      || !Number.isSafeInteger(read.value.issued) || read.value.issued < 0
      || !Number.isSafeInteger(read.value.received) || read.value.received < 0
      || read.value.received > read.value.issued) state = 'invalid';
    else {
      return { order: read.value, state: '' };
    }
  }
  return { order: { issued: 0, received: 0 }, state };
}

function withMachineSettings<T>(serverUrl: string, mycoHome: string, apply: (file: string, order: MachineAnswerOrder) => T, requireDurableIssue = false): T {
  ensureMemberDir(deploymentsDir(mycoHome), mycoHome);
  const file = machineSettingsPath(serverUrl, mycoHome);
  const orderFile = `${file}.order`;
  const checkpointFile = `${orderFile}-checkpoint`;
  const lockFile = `${file}.lock`;
  ensurePrivateFile(lockFile);
  return withFileLockSync(lockFile, () => {
    const primary = readMachineAnswerOrder(orderFile);
    const checkpoint = readMachineAnswerOrder(checkpointFile);
    const order = primary.order;
    const state = [primary.state, checkpoint.state === '' ? '' : `checkpoint:${checkpoint.state}`].filter(Boolean).join('; ');
    const cached = fs.existsSync(file) ? readPrivateJson<unknown>(file) : null;
    const cachedOrder = cached?.ok ? machineBlockOf(cached.value)?.cachedOrder ?? 0 : 0;
    const volatile = volatileOrders.get(orderFile);
    order.issued = Math.max(order.issued, checkpoint.order.issued, cachedOrder, volatile?.issued ?? 0);
    order.received = Math.max(order.received, checkpoint.order.received, cachedOrder, volatile?.received ?? 0);
    let result: T;
    try { result = apply(file, order); }
    catch (error) { orderDiagnostic(orderFile, state); throw error; }
    order.issued = Math.max(order.issued, order.received);
    volatileOrders.set(orderFile, { ...order });
    const content = `${JSON.stringify(order)}\n`;
    const persist = (target: string): string | null => {
      try { writePrivateFileAtomic(target, content); return null; }
      catch (error) { return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable'; }
    };
    const checkpointError = persist(checkpointFile);
    const orderError = persist(orderFile);
    orderDiagnostic(orderFile, [state, checkpointError === null ? '' : `checkpoint-write:${checkpointError}`, orderError === null ? '' : `write:${orderError}`].filter(Boolean).join('; '));
    if (requireDurableIssue && checkpointError !== null && orderError !== null) throw new Error('Cannot persist machine settings request order.');
    return result;
  });
}

/** Allocate a machine-settings answer's stamp before its request, shared across project helpers. */
export function beginMachineSettingsRequest(serverUrl: string, mycoHome: string): number {
  return withMachineSettings(serverUrl, mycoHome, (_file, order) => nextMachineAnswerOrder(order), true);
}

/**
 * Record the settings `serverUrl` answered for this machine, in the home the membership is held under: the caller
 * names it, as the hook resolves it from its own directory, so a pinned project's settings land beside its own
 * membership. Written whole or not at all. Any other value changes nothing.
 */
export function cacheMachineSettings(serverUrl: string, answered: unknown, mycoHome: string, requestOrder?: number): boolean {
  const block = machineBlockOf(answered);
  if (block === null) return false;
  return withMachineSettings(serverUrl, mycoHome, (file, order) => {
    const stamp = requestOrder ?? nextMachineAnswerOrder(order);
    if (stamp < order.received) return false;
    order.received = stamp;
    writePrivateFileAtomic(file, `${JSON.stringify({ ...block, cachedOrder: stamp })}\n`);
    return true;
  });
}

/** The extra plan folders `serverUrl` holds for this machine, read from the home `mycoHome` names: `~/`, absolute, or relative to each project root. */
export function machinePlanDirs(serverUrl: string, mycoHome: string): string[] {
  const file = machineSettingsPath(serverUrl, mycoHome);
  if (!fs.existsSync(file)) return [];
  const read = readPrivateJson<unknown>(file);
  const block = read.ok ? machineBlockOf(read.value) : null;
  const dirs = block?.leaves[PLAN_DIRS_LEAF];
  return resolveMachineSetting(PLAN_DIRS_LEAF, dirs ?? MACHINE_SETTING_SPECS[PLAN_DIRS_LEAF].default).effective as string[];
}

/** The folders this machine captures repositories under without being asked. */
export const AUTO_JOIN_ROOTS_LEAF = 'capture.auto_join_roots';
/** What the Deployment answers for the folders when it has answered nothing: the value it applies to an unset leaf. */
export const DEFAULT_AUTO_JOIN_ROOTS: readonly string[] = MACHINE_SETTING_SPECS[AUTO_JOIN_ROOTS_LEAF].default;
/** The repositories this machine is told to connect from "Needs you", by key: a project id, or `''` for the one its remote names or one created for it. */
export const CONNECT_ROOTS_LEAF = 'capture.connect_roots';

/** The leaves auto-join reads, as `serverUrl` last answered them for this machine, each at its default where nothing is cached. */
export function machineAutoJoinLeaves(serverUrl: string, mycoHome: string): { autoJoinRoots: string[]; connectRoots: Record<string, string> } {
  const file = machineSettingsPath(serverUrl, mycoHome);
  const read = fs.existsSync(file) ? readPrivateJson<unknown>(file) : null;
  const leaves = read !== null && read.ok ? machineBlockOf(read.value)?.leaves ?? {} : {};
  const roots = leaves[AUTO_JOIN_ROOTS_LEAF];
  const connect = leaves[CONNECT_ROOTS_LEAF];
  return {
    autoJoinRoots: resolveMachineSetting(AUTO_JOIN_ROOTS_LEAF, roots ?? DEFAULT_AUTO_JOIN_ROOTS).effective as string[],
    connectRoots: resolveMachineSetting(CONNECT_ROOTS_LEAF, connect ?? {}).effective as Record<string, string>,
  };
}

/** Forget, in this machine's cache, that `serverUrl` told it to connect a repository it left; the Deployment is told so too. */
export function forgetConnectRoot(serverUrl: string, rootKey: string, mycoHome: string): void {
  withMachineSettings(serverUrl, mycoHome, (file, order) => {
    const read = fs.existsSync(file) ? readPrivateJson<unknown>(file) : null;
    const block = read !== null && read.ok ? machineBlockOf(read.value) : null;
    const connect = block?.leaves[CONNECT_ROOTS_LEAF];
    if (block === null || typeof connect !== 'object' || connect === null || !Object.prototype.hasOwnProperty.call(connect, rootKey)) return;
    const kept = Object.fromEntries(Object.entries(connect as Record<string, unknown>).filter(([key]) => key !== rootKey));
    order.received = nextMachineAnswerOrder(order);
    writePrivateFileAtomic(file, `${JSON.stringify({ cachedOrder: order.received, leaves: { ...block.leaves, [CONNECT_ROOTS_LEAF]: kept }, ...(block.feature === MACHINE_SETTINGS_FEATURE ? { feature: MACHINE_SETTINGS_FEATURE, invalidated: true } : {}) })}\n`);
  });
}

/** Advertise this member's contract support and report only a revision durably cached from a supporting Deployment. */
export function machineSettingsHeaders(serverUrl: string, mycoHome: string): Record<string, string> {
  return withMachineSettings(serverUrl, mycoHome, (file, order) => {
    const read = fs.existsSync(file) ? readPrivateJson<unknown>(file) : null;
    const block = read?.ok ? machineBlockOf(read.value) : null;
    return {
      [MACHINE_SETTINGS_HEADER]: MACHINE_SETTINGS_FEATURE,
      ...(block?.revision !== undefined ? { [MACHINE_SETTINGS_REVISION_HEADER]: block.revision, [MACHINE_SETTINGS_ORDER_HEADER]: String(block.cachedOrder ?? order.received) } : {}),
      ...(block?.invalidated === true ? { [MACHINE_SETTINGS_INVALIDATED_HEADER]: '1', [MACHINE_SETTINGS_ORDER_HEADER]: String(block.cachedOrder ?? order.received) } : {}),
    };
  });
}

/** Where a Deployment answers its settings, with this machine's own among them. */
export const SETTINGS_READ_PATH = '/members/settings';

/**
 * Ask `serverUrl` for this machine's settings and cache them: what a sign-in, a join and a cutover do, so a machine
 * follows its settings from its first session. A Deployment that does not answer leaves the cache as it was: the
 * next session start asks again.
 */
export async function seedMachineSettings(
  record: { serverUrl: string; token: string }, opts: { mycoHome: string; fetch?: FetchLike },
): Promise<boolean> {
  try {
    const client = new ServerClient({ serverUrl: record.serverUrl, token: record.token }, opts.fetch ?? globalThis.fetch);
    const requestOrder = beginMachineSettingsRequest(record.serverUrl, opts.mycoHome);
    const raw = await client.request('POST', SETTINGS_READ_PATH, {
      body: '{}', headers: { 'content-type': 'application/json', ...machineSettingsHeaders(record.serverUrl, opts.mycoHome) }, scope: 'deployment',
      budget: { connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS, requestTimeoutMs: SEED_TIMEOUT_MS },
    });
    if (raw.kind !== 'response' || raw.status !== 200 || raw.json === null) return false;
    return cacheMachineSettings(record.serverUrl, raw.json.machine, opts.mycoHome, requestOrder);
  } catch {
    return false;
  }
}

/** How long a sign-in waits for its settings before carrying on without them. */
const SEED_TIMEOUT_MS = 10_000;
