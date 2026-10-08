import { hostname as osHostname, platform } from 'node:os';
import { getMachineId } from '../machine-id.js';
import { getPluginVersion } from '../version.js';
import { deploymentUrl } from '../member/registry.js';
import {
  clearPending, isLiveRunner, newRunnerBearer, publishRunnerRecord, readRunnerRecord, removeRunnerRecord, RUNNER_RECORD_VERSION, stagePending, withRunnerLock,
  type PendingRegister, type RunnerLock, type RunnerRecord,
} from '../runner/runner-registry.js';
import { contactRunner, parseContact, type RunnerContact } from '../runner/runner-routes.js';
import { resolveMycoHome } from '../paths/home.js';
import { runDeviceFlow, type DeviceFlowSpec, type DeviceGrant } from './device-flow.js';
import { parseFlags } from './flags.js';
import { defaultRunnerName, RUNNER_ADDRESS_RULE, RUNNER_NAME_PATTERN, runnerServerUrl, type RunnerCliDeps } from './runner-deps.js';

/** Poll errors after which the Deployment may nonetheless have committed the registration. */
const MAYBE_COMMITTED_CODES: readonly string[] = ['unreachable', 'unreadable', 'expired_token', 'invalid_grant'];
/** Failures that leave the registration open for a later run to settle. */
const TRANSIENT_CODES: readonly string[] = ['unreachable', 'unreadable'];

export interface RegisteredRunner {
  runnerId: string;
  name: string;
  deploymentId: string;
}

const runnerRegistration = (serverUrl: string, name: string): DeviceFlowSpec<RegisteredRunner> => ({
  noun: 'registration',
  startPath: '/auth/runner/start',
  pollPath: '/auth/runner/poll',
  announce: (userCode) => [
    `Open ${serverUrl}/device on a machine signed in to the dashboard.`,
    `Code: ${userCode}`,
    `The approver is asked to "Register a runner named ${name}". Check the details and approve it there. Waiting for approval…`,
  ],
  accept: (response, answer) => response.ok && answer.registered === true && typeof answer.runnerId === 'string'
    && typeof answer.name === 'string' && typeof answer.deploymentId === 'string'
    ? { runnerId: answer.runnerId, name: answer.name, deploymentId: answer.deploymentId } : null,
  refusals: {
    access_denied: 'registration was denied in the dashboard',
    expired_token: 'registration expired; run myco runner register again',
    invalid_grant: 'registration has expired or was already used; run myco runner register again',
  },
  otherRefusal: 'the Deployment refused this registration; run myco runner register again',
});

/** Whether a registration's device grant can still be polled. */
function resumableGrant(pending: PendingRegister, now: number): DeviceGrant | null {
  if (pending.deviceCode === undefined || pending.userCode === undefined || pending.deviceExpiresAt === undefined || pending.pollIntervalSeconds === undefined) return null;
  if (now >= pending.deviceExpiresAt) return null;
  return { deviceCode: pending.deviceCode, userCode: pending.userCode, expiresAt: pending.deviceExpiresAt, intervalSeconds: pending.pollIntervalSeconds };
}

type Committed =
  | { kind: 'committed'; contact: RunnerContact }
  | { kind: 'not-committed' }
  | { kind: 'unknown'; detail: string };

/** Whether the Deployment holds this candidate as a runner's credential: a contact it answers means the registration committed; a refusal of the bearer means it did not. */
async function committedWith(serverUrl: string, candidate: string, metadata: { machineId: string; os: string }, fetchImpl: typeof fetch | undefined): Promise<Committed> {
  const outcome = await contactRunner(serverUrl, candidate, { ...metadata, version: getPluginVersion() }, fetchImpl);
  switch (outcome.class) {
    case 'acked': {
      const contact = parseContact(outcome.body);
      return contact === null ? { kind: 'unknown', detail: 'the Deployment answered the contact in a shape this runner does not read' } : { kind: 'committed', contact };
    }
    case 'unauthorized': return { kind: 'not-committed' };
    case 'retry': return { kind: 'unknown', detail: outcome.detail };
    case 'slow': return { kind: 'unknown', detail: outcome.detail };
    case 'route_missing': return { kind: 'unknown', detail: 'the Deployment serves no runner routes at this address' };
    case 'protocol': return { kind: 'unknown', detail: `the Deployment speaks member protocol ${outcome.serverProtocol ?? '?'}` };
    default: return { kind: 'unknown', detail: `the Deployment refused the contact (${outcome.class})` };
  }
}

export const REGISTER_USAGE = 'usage: myco runner register <host> [--name <name>] [--replace]';

/** Register this machine as a runner of the Deployment at `<host>`, and report whether it is registered. */
export async function registerRunner(args: readonly string[], deps: RunnerCliDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? Date.now;
  const fail = (line: string): boolean => { err(`myco runner register: ${line}`); return false; };

  const { positionals, flags } = parseFlags([...args]);
  if (positionals.length !== 1) return fail(REGISTER_USAGE);
  const serverUrl = runnerServerUrl(positionals[0]!);
  if (serverUrl === null) return fail(RUNNER_ADDRESS_RULE);
  const named = flags.get('name');
  if (named === 'true') return fail('--name needs a value');
  const name = named ?? defaultRunnerName((deps.hostname ?? osHostname)());
  if (!RUNNER_NAME_PATTERN.test(name)) return fail('a runner name is 1 to 64 letters, digits, dots, underscores or dashes');

  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const replace = flags.get('replace') === 'true';
  const existing = readRunnerRecord(serverUrl, mycoHome);
  if (isLiveRunner(existing) && !replace) return fail(`this machine is already registered with ${serverUrl} as ${existing.name}; start it with \`myco runner run --server ${serverUrl}\`, or register it afresh with --replace`);

  const machine = { machineId: deps.machineId ?? getMachineId(), machineName: (deps.hostname ?? osHostname)(), os: (deps.os ?? platform)() };
  const metadata = { machineId: machine.machineId, os: machine.os };

  const commit = (lock: RunnerLock, candidate: string, registered: RegisteredRunner, contact?: RunnerContact): boolean => {
    const record: RunnerRecord = {
      version: RUNNER_RECORD_VERSION, serverUrl: deploymentUrl(serverUrl), deploymentId: registered.deploymentId, runnerId: registered.runnerId, name: registered.name, token: candidate,
      ...(contact === undefined ? {} : { tokenId: contact.credential.id, tokenExpiresAt: contact.credential.expiresAt, refreshAfter: contact.credential.refreshAfter }),
    };
    publishRunnerRecord(lock, record);
    out(`Registered runner ${registered.name} (${registered.runnerId}) with ${serverUrl}.`);
    out(`Start it with: myco runner run --server ${serverUrl}`);
    return true;
  };
  const commitContact = (lock: RunnerLock, candidate: string, contact: RunnerContact): boolean =>
    commit(lock, candidate, { runnerId: contact.runner.id, name: contact.runner.name, deploymentId: contact.runner.deploymentId }, contact);

  const locked = await withRunnerLock(serverUrl, async (lock): Promise<boolean> => {
    let held = readRunnerRecord(serverUrl, mycoHome);
    if (isLiveRunner(held)) {
      if (!replace) return fail(`this machine is already registered with ${serverUrl} as ${held.name}`);
      removeRunnerRecord(lock);
      held = null;
    }
    let pending: PendingRegister | null = held?.pending?.kind === 'register' ? held.pending : null;
    let grant: DeviceGrant | null = null;
    let displayName = name;
    if (pending !== null) {
      displayName = held!.name;
      const settled = await committedWith(serverUrl, pending.candidate, metadata, deps.fetch);
      if (settled.kind === 'committed') return commitContact(lock, pending.candidate, settled.contact);
      if (settled.kind === 'unknown') return fail(`could not tell whether the earlier registration completed (${settled.detail}); run it again to settle it`);
      grant = resumableGrant(pending, now());
      if (grant === null) {
        clearPending(lock);
        pending = null;
        displayName = name;
      }
    }
    if (pending === null) {
      pending = { kind: 'register', candidate: newRunnerBearer(), startedAt: now() };
      stagePending(lock, pending, displayName);
    }
    const candidate = pending.candidate;
    const registration = pending;

    const flow = await runDeviceFlow(serverUrl, runnerRegistration(serverUrl, displayName), { name: displayName, ...machine, candidate },
      { fetch: deps.fetch, stdout: out, sleep: deps.sleep, clock: now },
      {
        onStarted: (started) => {
          stagePending(lock, {
            ...registration, deviceCode: started.deviceCode, userCode: started.userCode, deviceExpiresAt: started.expiresAt, pollIntervalSeconds: started.intervalSeconds,
          }, displayName);
        },
        ...(grant === null ? {} : { resume: grant }),
      });
    if (flow.ok) return commit(lock, candidate, flow.answer);

    if (MAYBE_COMMITTED_CODES.includes(flow.code)) {
      const settled = await committedWith(serverUrl, candidate, metadata, deps.fetch);
      if (settled.kind === 'committed') return commitContact(lock, candidate, settled.contact);
      if (settled.kind === 'unknown') return fail(`${flow.reason} (${flow.code}); the registration may still have completed — run \`myco runner register ${positionals[0]}\` again to settle it`);
    }
    if (TRANSIENT_CODES.includes(flow.code)) return fail(`${flow.reason} (${flow.code}); run \`myco runner register ${positionals[0]}\` again to pick it up`);
    clearPending(lock);
    return fail(`${flow.reason} (${flow.code})`);
  }, mycoHome);
  if (!locked.held) return fail(`another myco runner process is working on ${serverUrl}${locked.holder === null ? '' : ` (process ${locked.holder.pid})`}`);
  return locked.value;
}
