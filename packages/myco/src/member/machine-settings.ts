/**
 * The settings a Deployment holds for this machine (#1393), as this machine caches them: one file per Deployment,
 * beside its membership, written whenever the Deployment answers them (session start, `/members/settings`) and read
 * by the hooks without a request. Offline, the last answer stands; with none, every leaf is at its default.
 *
 * An answer that carries no settings leaves the file as it is: a credential that joined no machine is told nothing,
 * and that is not an instruction to forget what this machine was told before.
 */
import { MACHINE_UPDATE_HEADER, MACHINE_UPDATE_LEAVES, machineUpdateRequests, type MachineSettingsBlock, type MachineUpdateReport } from '@goondocks/myco-shared/member-protocol';
import { readAutomaticUpdatePreference, readInstallMarker, readUpdateChannelPreference } from '@myco/install/marker-reader.js';
import { applyMachineUpdateRequests, readAppliedUpdateRequests } from './automatic-update-state.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { DISMISSED_ROOTS_LEAF, MACHINE_SETTING_SPECS, MACHINE_SETTINGS_FEATURE, MACHINE_SETTINGS_HEADER, MACHINE_SETTINGS_REVISION_HEADER, MACHINE_SETTINGS_ORDER_HEADER, MACHINE_SETTINGS_INVALIDATED_HEADER, isMachineSettingsRevision, resolveMachineSetting } from '@goondocks/myco-shared/member-protocol';
import { deploymentKeyFor, deploymentsDir, machineSettingsPath } from './registry.js';
import { ensureMemberDir, ensurePrivateFile, readPrivateJson, writePrivateFileAtomic } from './store.js';
import { CONNECT_TIMEOUT_CAP_MS } from './constants.js';
import { ServerClient, type FetchLike } from './transport.js';
import type { RequestBudget } from './budget.js';
import { terminalText } from '@myco/utils/terminal-text.js';
import { assertDeploymentTokenPair } from './token-pairing.js';

/** The leaf naming the folders this machine's agents write plans to, beyond the ones each agent's manifest names. */
export const PLAN_DIRS_LEAF = 'capture.plan_dirs';

function validOrder(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The settings block a Deployment answers, or null when the value is not one. */
export function machineBlockOf(value: unknown): (MachineSettingsBlock & { invalidated?: true; cachedOrder?: number }) | null {
  if (typeof value !== 'object' || value === null) return null;
  const leaves = (value as { leaves?: unknown }).leaves;
  if (typeof leaves !== 'object' || leaves === null || Array.isArray(leaves)) return null;
  const block = value as { feature?: unknown; revision?: unknown; invalidated?: unknown; cachedOrder?: unknown; cacheConfirmed?: unknown; updateRequests?: unknown; serverNow?: unknown };
  const supported = block.feature === MACHINE_SETTINGS_FEATURE;
  return { leaves: leaves as Record<string, unknown>, ...(supported && block.cacheConfirmed === true ? { cacheConfirmed: true as const } : {}), ...(block.updateRequests === undefined ? {} : { updateRequests: machineUpdateRequests(block.updateRequests) }), ...(validOrder(block.serverNow) ? { serverNow: block.serverNow } : {}), ...(supported && isMachineSettingsRevision(block.revision) ? { feature: MACHINE_SETTINGS_FEATURE, revision: block.revision } : {}), ...(supported && block.invalidated === true ? { feature: MACHINE_SETTINGS_FEATURE, invalidated: true as const } : {}), ...(validOrder(block.cachedOrder) ? { cachedOrder: block.cachedOrder } : {}) };
}

interface MachineAnswerOrder { issued: number; received: number; report?: { state: string; order: number }; reported?: MachineUpdateReport }
const ORDER_CLOCK_SCALE = 1_000;
const orderDiagnostics = new Map<string, string>();
const volatileOrders = new Map<string, MachineAnswerOrder>();

/** Allocate a stamp above previous requests and the clock's current millisecond. */
function nextMachineAnswerOrder(order: MachineAnswerOrder): number {
  const stamp = Math.max(order.issued + 1, Date.now() * ORDER_CLOCK_SCALE);
  if (!validOrder(stamp)) throw new Error('Machine settings answer order exhausted.');
  order.issued = stamp;
  return stamp;
}

/** Report an advisory order-file state once until its state changes. */
function orderDiagnostic(orderFile: string, state: string): void {
  const diagnosticFile = `${orderFile}-diagnostic`;
  let changed = orderDiagnostics.get(orderFile) !== state;
  try {
    const read = readPrivateJson<{ state: string }>(diagnosticFile);
    if (!state && !read.ok && read.reason === 'missing') {
      return;
    }
    if (read.ok) changed = read.value?.state !== state;
    if (changed || !read.ok) writePrivateFileAtomic(diagnosticFile, `${JSON.stringify({ state })}\n`);
  } catch { /* keep the process-local deduplication when diagnostics cannot be persisted */ }
  finally { orderDiagnostics.set(orderFile, state); }
  if (changed && state) process.stderr.write(`[myco] member: machine settings answer order reset (${state}) ${orderFile}\n`);
}

/** The order file sequences answers and reports; its cached generation survives a damaged sidecar. */
function readMachineAnswerOrder(orderFile: string): { order: MachineAnswerOrder; state: string } {
  const order: MachineAnswerOrder = { issued: 0, received: 0 };
  const read = readPrivateJson<MachineAnswerOrder>(orderFile, { entry: 'owned-file' });
  const value = read.ok ? read.value : null;
  if (value && typeof value === 'object' && validOrder(value.issued) && validOrder(value.received) && value.received <= value.issued) return { order: value, state: '' };
  const state = read.ok ? 'invalid' : read.reason === 'missing' ? '' : read.reason === 'unreadable' ? read.detail ?? 'unreadable' : read.reason;
  return { order, state };
}

function readCachedMachineSettings(file: string): ReturnType<typeof machineBlockOf> {
  const read = readPrivateJson<unknown>(file);
  return read.ok ? machineBlockOf(read.value) : null;
}

type CacheMachineAnswer = (answered: NonNullable<ReturnType<typeof machineBlockOf>>, requestOrder: number | undefined, receivedAt: number) => boolean;

function withMachineSettings<T>(serverUrl: string, mycoHome: string, apply: (file: string, order: MachineAnswerOrder, block: ReturnType<typeof machineBlockOf>, cache: CacheMachineAnswer) => T, requireDurableIssue = false): T {
  ensureMemberDir(deploymentsDir(mycoHome), mycoHome);
  const file = machineSettingsPath(serverUrl, mycoHome);
  const orderFile = `${file}.order`;
  const checkpointFile = `${orderFile}-checkpoint`;
  const lockFile = `${file}.lock`;
  ensurePrivateFile(lockFile);
  return withFileLockSync(lockFile, () => {
    const primary = readMachineAnswerOrder(orderFile);
    const checkpoint = readMachineAnswerOrder(checkpointFile);
    const volatile = volatileOrders.get(orderFile);
    const order = { ...[primary.order, checkpoint.order, volatile ?? primary.order].reduce((a, b) => a.issued >= b.issued ? a : b) };
    const state = [primary.state, checkpoint.state && `checkpoint:${checkpoint.state}`].filter(Boolean).join('; ');
    const block = readCachedMachineSettings(file);
    const cachedOrder = block?.cachedOrder ?? 0;
    order.issued = Math.max(order.issued, cachedOrder);
    order.received = Math.max(primary.order.received, checkpoint.order.received, cachedOrder, volatile?.received ?? 0);
    const cache: CacheMachineAnswer = (answered, requestOrder, receivedAt) => {
      const stamp = requestOrder ?? nextMachineAnswerOrder(order);
      if (stamp < order.received) return false;
      let updateApplyError: string | undefined;
      try {
        applyMachineUpdateRequests(mycoHome, { deployment: deploymentKeyFor(serverUrl), requests: answered.updateRequests ?? {}, clockOffsetMs: (answered.serverNow ?? receivedAt) - receivedAt });
        updateWarnings.delete(file);
      } catch (error) { updateApplyError = updateSettingsProblem(file, error); }
      order.received = stamp;
      writePrivateFileAtomic(file, `${JSON.stringify({ ...answered, cachedOrder: answered.cacheConfirmed && answered.revision === block?.revision ? block?.cachedOrder ?? stamp : stamp, ...(updateApplyError === undefined ? {} : { updateApplyError }) })}\n`);
      return true;
    };
    let result: T;
    try { result = apply(file, order, block, cache); }
    catch (error) { orderDiagnostic(orderFile, state); throw error; }
    order.issued = Math.max(order.issued, order.received);
    volatileOrders.set(orderFile, order);
    const content = `${JSON.stringify(order)}\n`;
    const persist = (target: string, prior: ReturnType<typeof readMachineAnswerOrder>): string | null => {
      if (!prior.state && `${JSON.stringify(prior.order)}\n` === content) return null;
      try { writePrivateFileAtomic(target, content); return null; }
      catch (error) { return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable'; }
    };
    const checkpointError = persist(checkpointFile, checkpoint);
    const orderError = persist(orderFile, primary);
    orderDiagnostic(orderFile, [state, checkpointError === null ? '' : `checkpoint-write:${checkpointError}`, orderError === null ? '' : `write:${orderError}`].filter(Boolean).join('; '));
    if (requireDurableIssue && checkpointError !== null && orderError !== null) throw new Error('Cannot persist machine settings request order.');
    return result;
  });
}

/** Allocate a machine-settings answer's stamp before its request, shared across project helpers. */
export function beginMachineSettingsRequest(serverUrl: string, mycoHome: string): number {
  return withMachineSettings(serverUrl, mycoHome, (_file, order) => nextMachineAnswerOrder(order), true);
}

const updateWarnings = new Map<string, string>();

function updateSettingsProblem(file: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const previous = readPrivateJson<{ updateApplyError?: string }>(file);
  if (updateWarnings.get(file) !== message && (!previous.ok || previous.value?.updateApplyError !== message)) {
    process.stderr.write(`[myco] member: update settings unavailable: ${message}\n`);
  }
  updateWarnings.set(file, message);
  return message;
}

/**
 * Record the settings `serverUrl` answered for this machine, in the home the membership is held under: the caller
 * names it, as the hook resolves it from its own directory, so a pinned project's settings land beside its own
 * membership. Written whole or not at all. Any other value changes nothing.
 */
export function cacheMachineSettings(serverUrl: string, answered: unknown, mycoHome: string, requestOrder?: number, now: () => number = Date.now): boolean {
  const receivedAt = now();
  const block = machineBlockOf(answered);
  if (block === null) return false;
  return withMachineSettings(serverUrl, mycoHome, (_file, _order, _cached, cache) => cache(block, requestOrder, receivedAt));
}

function machineFolders(leaf: 'capture.plan_dirs' | 'capture.prompt_file_roots', serverUrl: string, mycoHome: string): string[] {
  const leaves = readCachedMachineSettings(machineSettingsPath(serverUrl, mycoHome))?.leaves;
  return resolveMachineSetting(leaf, leaves?.[leaf] ?? MACHINE_SETTING_SPECS[leaf].default).effective as string[];
}

/** Extra plan folders from this machine's last settings answer. */
export function machinePlanDirs(serverUrl: string, mycoHome: string): string[] {
  return machineFolders('capture.plan_dirs', serverUrl, mycoHome);
}

/** Explicitly approved prompt-file folders from this machine's last settings answer. */
export function machinePromptFileRoots(serverUrl: string, mycoHome: string): string[] {
  return machineFolders('capture.prompt_file_roots', serverUrl, mycoHome);
}

/** The folders this machine captures repositories under without being asked. */
export const AUTO_JOIN_ROOTS_LEAF = 'capture.auto_join_roots';
/** What the Deployment answers for the folders when it has answered nothing: the value it applies to an unset leaf. */
export const DEFAULT_AUTO_JOIN_ROOTS: readonly string[] = MACHINE_SETTING_SPECS[AUTO_JOIN_ROOTS_LEAF].default;
/** The repositories this machine is told to connect from "Needs you", by key: a project id, or `''` for the one its remote names or one created for it. */
export const CONNECT_ROOTS_LEAF = 'capture.connect_roots';

/** The folders whose repositories this machine never asks about, and the repositories dismissed from "Needs you". */
const QUIET_ROOTS_LEAF = 'capture.quiet_roots';

/** The leaves auto-join reads, as `serverUrl` last answered them for this machine, each at its default where nothing is cached. */
export function machineAutoJoinLeaves(serverUrl: string, mycoHome: string): { autoJoinRoots: string[]; connectRoots: Record<string, string>; quietRoots: string[]; dismissedRoots: Record<string, string> } {
  const leaves = readCachedMachineSettings(machineSettingsPath(serverUrl, mycoHome))?.leaves ?? {};
  const roots = leaves[AUTO_JOIN_ROOTS_LEAF];
  const connect = leaves[CONNECT_ROOTS_LEAF];
  return {
    autoJoinRoots: resolveMachineSetting(AUTO_JOIN_ROOTS_LEAF, roots ?? DEFAULT_AUTO_JOIN_ROOTS).effective as string[],
    connectRoots: resolveMachineSetting(CONNECT_ROOTS_LEAF, connect ?? {}).effective as Record<string, string>,
    quietRoots: resolveMachineSetting(QUIET_ROOTS_LEAF, leaves[QUIET_ROOTS_LEAF] ?? []).effective as string[],
    dismissedRoots: resolveMachineSetting(DISMISSED_ROOTS_LEAF, leaves[DISMISSED_ROOTS_LEAF] ?? {}).effective as Record<string, string>,
  };
}

/** Forget, in this machine's cache, that `serverUrl` told it to connect a repository it left; the Deployment is told so too. */
export function forgetConnectRoot(serverUrl: string, rootKey: string, mycoHome: string): void {
  withMachineSettings(serverUrl, mycoHome, (file, order, block) => {
    const connect = block?.leaves[CONNECT_ROOTS_LEAF];
    if (block === null || typeof connect !== 'object' || connect === null || !Object.prototype.hasOwnProperty.call(connect, rootKey)) return;
    const kept = Object.fromEntries(Object.entries(connect as Record<string, unknown>).filter(([key]) => key !== rootKey));
    order.received = nextMachineAnswerOrder(order);
    writePrivateFileAtomic(file, `${JSON.stringify({ cachedOrder: order.received, leaves: { ...block.leaves, [CONNECT_ROOTS_LEAF]: kept }, ...(block.feature === MACHINE_SETTINGS_FEATURE ? { feature: MACHINE_SETTINGS_FEATURE, invalidated: true } : {}) })}\n`);
  });
}

/** Advertise this member's contract support and report only a revision durably cached from a supporting Deployment. */
export function machineSettingsHeaders(serverUrl: string, mycoHome: string): Record<string, string> {
  return withMachineSettings(serverUrl, mycoHome, (_file, order, block) => machineHeaders(serverUrl, mycoHome, order, block));
}

function machineHeaders(serverUrl: string, mycoHome: string, order: MachineAnswerOrder, block: ReturnType<typeof machineBlockOf>): Record<string, string> {
  const state = machineUpdateState(serverUrl, mycoHome);
  const key = JSON.stringify(state);
  if (order.report?.state !== key || !validOrder(order.report.order) || order.report.order > order.issued) order.report = { state: key, order: nextMachineAnswerOrder(order) };
  const cachedOrder = String(block?.cachedOrder ?? order.received);
  return {
    [MACHINE_SETTINGS_HEADER]: MACHINE_SETTINGS_FEATURE,
    [MACHINE_UPDATE_HEADER]: JSON.stringify({ order: order.report.order, ...state }),
    ...(block?.revision !== undefined ? { [MACHINE_SETTINGS_REVISION_HEADER]: block.revision, [MACHINE_SETTINGS_ORDER_HEADER]: cachedOrder } : {}),
    ...(block?.invalidated === true ? { [MACHINE_SETTINGS_INVALIDATED_HEADER]: '1', [MACHINE_SETTINGS_ORDER_HEADER]: cachedOrder } : {}),
  };
}

/** One request's settings headers and its ordered answer, including the report the Deployment accepted. */
export function machineSettingsExchange(serverUrl: string, home: string) {
  const { stamp, headers, reported } = withMachineSettings(serverUrl, home, (_file, order, block) => ({
    stamp: nextMachineAnswerOrder(order), headers: machineHeaders(serverUrl, home, order, block), reported: order.reported?.order ?? -1,
  }), true);
  const report = JSON.parse(headers[MACHINE_UPDATE_HEADER]!) as MachineUpdateReport;
  return { headers, receive: (answer: { machine?: unknown; acknowledged?: string | null; at?: number }) => {
    const block = machineBlockOf(answer.machine);
    const accepted = (!validOrder(reported) || report.order > reported) && (answer.acknowledged === String(report.order) || block?.updateRequests !== undefined);
    if (!accepted && !block) return false;
    return withMachineSettings(serverUrl, home, (_file, order, _cached, cache) => {
      const latest = order.reported?.order;
      if (accepted && (!validOrder(latest) || report.order > latest)) {
        order.reported = report;
        nextMachineAnswerOrder(order);
      }
      return block ? cache(block, stamp, answer.at ?? Date.now()) : false;
    });
  } };
}

/** Applied request receipts not yet acknowledged by this Deployment. */
export function machineSettingsReportPending(serverUrl: string, home: string): boolean {
  const requests = machineUpdateState(serverUrl, home).requests;
  if (Object.keys(requests).length === 0) return false;
  return withMachineSettings(serverUrl, home, (_file, order) => {
    return MACHINE_UPDATE_LEAVES.some(leaf => requests[leaf] !== undefined && requests[leaf]!.id !== order.reported?.requests?.[leaf]?.id);
  });
}

/** Values and receipts whose local authority is readable; an unreadable preference confirms nothing. */
export function machineUpdateState(serverUrl: string, mycoHome: string): Omit<MachineUpdateReport, 'order'> {
  try {
    return { requests: readAppliedUpdateRequests(mycoHome, deploymentKeyFor(serverUrl)), values: reportedUpdateValues(mycoHome) };
  } catch { return { requests: {}, values: {} }; }
}

/** Report only values whose local authority is readable. */
function reportedUpdateValues(home: string): Record<string, boolean | string> {
  const values: Record<string, boolean | string> = {};
  const automatic = readAutomaticUpdatePreference(home);
  if (automatic.error === undefined) values['update.automatic'] = automatic.enabled;
  const preference = readUpdateChannelPreference(home);
  const channel = preference.channel ?? readInstallMarker(home, true)?.channel;
  if (preference.error === undefined && channel !== undefined && channel !== null) values['update.channel'] = channel;
  return values;
}

/** Where a Deployment answers its settings, with this machine's own among them. */
export const SETTINGS_READ_PATH = '/members/settings';

/**
 * Ask `serverUrl` for this machine's settings and cache them during sign-in, join, cutover and helper delivery.
 * A Deployment that does not answer leaves the cache as it was; the next settings read retries.
 */
export async function seedMachineSettings(
  record: { serverUrl: string; token: string }, opts: { mycoHome: string; fetch?: FetchLike; budget?: RequestBudget },
): Promise<boolean> {
  try { assertDeploymentTokenPair(record, opts.mycoHome); }
  catch (error) {
    process.stderr.write(`[myco] member: machine settings not fetched (${(error as Error).message})\n`);
    return false;
  }
  try {
    const client = new ServerClient({ serverUrl: record.serverUrl, token: record.token }, opts.fetch ?? globalThis.fetch);
    const exchange = machineSettingsExchange(record.serverUrl, opts.mycoHome);
    const raw = await client.request('POST', SETTINGS_READ_PATH, {
      body: '{}', headers: { 'content-type': 'application/json', ...exchange.headers }, scope: 'deployment',
      budget: opts.budget ?? { connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS, requestTimeoutMs: SEED_TIMEOUT_MS },
    });
    if (raw.kind !== 'response' || raw.status !== 200 || raw.json === null) {
      const reason = raw.kind === 'response' ? `HTTP ${raw.status}` : raw.kind === 'timeout' ? `timeout reading ${raw.phase}` : raw.detail;
      throw new Error(reason);
    }
    return exchange.receive({ machine: raw.json.machine });
  } catch (error) {
    process.stderr.write(`[myco] member: machine settings not fetched (${terminalText(error instanceof Error ? error.message : String(error))}); the next settings read retries.\n`);
    return false;
  }
}

/** How long a sign-in waits for its settings before carrying on without them. */
const SEED_TIMEOUT_MS = 10_000;
