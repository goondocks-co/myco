import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { LifecycleLock } from '../utils/lifecycle-lock.js';
import { CONNECT_TIMEOUT_CAP_MS } from './constants.js';
import { normalizeMemberServerAddress } from './server-url.js';
import { routeMissing, ServerClient } from './transport.js';
import { isLeft, rootKeyFor } from './auto-join.js';
import { pendingRoot } from './pending.js';
import {
  deploymentKeyFor, deploymentUrl, listDeploymentMembershipsResult, logoutBindings, membershipTokenDigest,
  readDeploymentMembershipResult, removeDeploymentForLogout, withRegistryLock, type ProjectBinding,
} from './registry.js';
import { readDefaultDeployment, reconcileDefaultDeployment } from './default-deployment.js';
import { assertMemberPathContained, ensureMemberDir, ensurePrivateFile, memberRoot, pathIsAbsent, readPrivateJson, writePrivateFileAtomic } from './store.js';

export type LogoutPhase = 'revoke' | 'local' | 'config' | 'done';
type RevokeOutcome = 'revoked' | 'still-valid';
interface LogoutJournal {
  version: 1;
  serverUrl: string;
  startedAt: number;
  phase: LogoutPhase;
  tokenDigest: string;
  machineId: string;
  bindings: ProjectBinding[];
  defaultUrl: string | null;
  agents: string[];
  workerUrls: string[];
  runner: boolean;
  revoke?: RevokeOutcome;
}

export interface LogoutReport {
  serverUrl: string;
  revoked: boolean;
  machineId: string;
  leftRoots: string[];
  defaultUrl: string | null;
  survivors: string[];
  keptSpool: { path: string; paths: string[]; sessions: number };
  runner: boolean;
}

export interface LogoutRuntime {
  aliases(serverUrl: string): Promise<readonly string[]>;
  snapshot(aliases: readonly string[]): { agents: string[]; workerUrls: string[]; runner: boolean };
  removeWorkers(urls: readonly string[]): void;
  reconcile(serverUrl: string, nextDefault: string | null, keepHooks: boolean, bindings: readonly ProjectBinding[], liveBindings: readonly ProjectBinding[]): void;
}

export interface LogoutDeps {
  mycoHome?: string;
  home?: string;
  fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  now?: () => number;
  runtime: LogoutRuntime;
  /** A durable phase boundary for interruption fixtures. */
  checkpoint?: (phase: LogoutPhase | 'revoked') => void | Promise<void>;
  /** A synchronous interruption boundary while the registry lock is held. */
  afterBindingsRemoved?: () => void;
}

export function logoutJournalPath(serverUrl: string, mycoHome: string): string {
  return path.join(memberRoot(mycoHome), 'logout', `${deploymentKeyFor(serverUrl)}.json`);
}

function memberships(mycoHome: string) {
  const listing = listDeploymentMembershipsResult(mycoHome);
  if (!listing.readable || listing.unavailableEntries !== 0) throw new Error('Could not read every Deployment membership; logout refused');
  return listing.memberships;
}

function readJournal(serverUrl: string, mycoHome: string): LogoutJournal | null {
  const file = logoutJournalPath(serverUrl, mycoHome);
  assertMemberPathContained(file, mycoHome);
  const read = readPrivateJson<LogoutJournal>(file);
  if (!read.ok) {
    if (read.reason === 'missing' && pathIsAbsent(file)) return null;
    throw new Error(`Could not read logout journal ${file}`);
  }
  const j = read.value;
  if (j?.version !== 1 || j.serverUrl !== serverUrl || !['revoke', 'local', 'config', 'done'].includes(j.phase)
    || !Number.isFinite(j.startedAt) || !/^[a-f0-9]{64}$/.test(j.tokenDigest) || typeof j.machineId !== 'string'
    || !Array.isArray(j.bindings) || !Array.isArray(j.agents) || !Array.isArray(j.workerUrls) || typeof j.runner !== 'boolean'
    || !(j.defaultUrl === null || typeof j.defaultUrl === 'string')
    || j.bindings.some((b) => typeof b?.root !== 'string' || typeof b.projectId !== 'string' || typeof b.serverUrl !== 'string' || deploymentUrl(b.serverUrl) !== serverUrl)
    || j.agents.some((a) => typeof a !== 'string') || j.workerUrls.some((u) => typeof u !== 'string')
    || (j.phase !== 'revoke' && j.revoke !== 'revoked' && j.revoke !== 'still-valid')) {
    throw new Error(`Invalid logout journal ${file}`);
  }
  return j;
}

function saveJournal(journal: LogoutJournal, mycoHome: string): void {
  writePrivateFileAtomic(logoutJournalPath(journal.serverUrl, mycoHome), `${JSON.stringify(journal, null, 2)}\n`);
}

async function revoke(j: LogoutJournal, mode: 'revoke' | 'local-only', deps: LogoutDeps, mycoHome: string): Promise<RevokeOutcome> {
  const held = withRegistryLock(() => readDeploymentMembershipResult(j.serverUrl, mycoHome), mycoHome);
  if (held.status !== 'present' || membershipTokenDigest(held.membership) !== j.tokenDigest) {
    throw new Error('The credential changed or is unavailable; logout cannot revoke the snapshotted credential');
  }
  const client = new ServerClient(held.membership, deps.fetch);
  const answer = await confirmRevocation(client, j.serverUrl);
  if (answer.revoked) return 'revoked';
  if (mode === 'local-only') return 'still-valid';
  throw new Error(answer.reason);
}

type RevocationAnswer = { revoked: true } | { revoked: false; reason: string };

async function confirmRevocation(client: ServerClient, serverUrl: string): Promise<RevocationAnswer> {
  const refused = (reason: string): RevocationAnswer => ({ revoked: false, reason });
  const budget = { connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS, requestTimeoutMs: CONNECT_TIMEOUT_CAP_MS };
  const response = await client.request('POST', '/members/credential/revoke', {
    body: '{}', headers: { 'content-type': 'application/json' }, scope: 'deployment', budget,
  });
  if (response.kind !== 'response') {
    return refused('The Deployment could not be reached; retry logout, or use --local-only to leave its credential valid');
  }
  if (routeMissing(response)) {
    return refused('This Deployment does not serve credential revocation; run `myco server update` for it, then retry logout');
  }
  if (response.status === 401) {
    const refresh = await client.refresh(budget);
    if (refresh.class === 'unauthorized' || (refresh.class === 'refused' && refresh.code === 'lineage_expired')) return { revoked: true };
    return refused('Credential revocation could not be confirmed; run `myco server update` for this Deployment, then retry logout');
  }
  if (response.status >= 200 && response.status < 300) {
    return response.json?.persisted === true ? { revoked: true } : refused('The Deployment did not acknowledge revocation; local state was kept');
  }
  if (response.status === 404) {
    return refused(`This address no longer answers Myco's revoke route (HTTP 404). If the Deployment moved or is gone, run myco logout ${serverUrl} --local-only to remove it from this machine (its credential stays valid on the server until it expires).`);
  }
  return refused(`The Deployment refused credential revocation (HTTP ${response.status}); local state was kept`);
}

function spoolReport(serverUrl: string, mycoHome: string): LogoutReport['keptSpool'] {
  const dir = path.join(memberRoot(mycoHome), 'spool', `d-${deploymentKeyFor(serverUrl)}`);
  const paths = [dir, path.join(pendingRoot(mycoHome), deploymentKeyFor(serverUrl))];
  let sessions = 0;
  for (const namespace of paths) {
    assertMemberPathContained(namespace, mycoHome);
    if (pathIsAbsent(namespace)) continue;
    for (const project of fs.readdirSync(namespace, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(namespace, project.name);
      assertMemberPathContained(projectDir, mycoHome);
      const names = fs.readdirSync(projectDir);
      sessions += new Set(names.flatMap((name) => name.endsWith('.jsonl') && name !== 'refused.jsonl' ? [name.slice(0, -6)]
        : name.endsWith('.transcript-backlog') ? [name.slice(0, -19)] : [])).size;
    }
  }
  return { path: dir, paths, sessions };
}

/** Revoke one Deployment credential and reconcile only the local state it owns. */
export async function logoutDeployment(input: string, opts: { mode: 'revoke' | 'local-only' }, deps: LogoutDeps): Promise<LogoutReport> {
  const address = normalizeMemberServerAddress(input);
  if (address === null) throw new Error('A Deployment address must be https, or http on this machine\'s loopback, with no account or password');
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const aliases = await deps.runtime.aliases(deploymentUrl(address.origin));
  const candidates = withRegistryLock(() => memberships(mycoHome).filter((m) => aliases.some((url) => deploymentKeyFor(url) === deploymentKeyFor(m.serverUrl))), mycoHome);
  if (candidates.length > 1) throw new Error('More than one membership matches this Deployment; logout refused');
  const pendingUrls = candidates.length === 0 ? aliases.filter((url) => readJournal(deploymentUrl(url), mycoHome) !== null) : [];
  if (pendingUrls.length > 1) throw new Error('More than one logout journal matches this Deployment; logout refused');
  const serverUrl = deploymentUrl(candidates[0]?.serverUrl ?? pendingUrls[0] ?? address.origin);
  const dir = path.dirname(logoutJournalPath(serverUrl, mycoHome));
  ensureMemberDir(dir, mycoHome);
  const lock = path.join(dir, `${deploymentKeyFor(serverUrl)}.lock`);
  const lease = withRegistryLock(() => {
    ensurePrivateFile(lock);
    return LifecycleLock.acquire(lock, { command: 'myco logout' });
  }, mycoHome);
  if (!lease.acquired) throw new Error('Logout is already running for this Deployment; retry when it finishes');
  try {
    let journal = withRegistryLock(() => {
      const saved = readJournal(serverUrl, mycoHome);
      const held = readDeploymentMembershipResult(serverUrl, mycoHome);
      const replaced = held.status === 'present' && saved !== null && membershipTokenDigest(held.membership) !== saved.tokenDigest;
      if (saved !== null && !replaced && (saved.phase !== 'done' || held.status === 'missing')) return saved;
      const all = memberships(mycoHome);
      const membership = all.find((m) => deploymentKeyFor(m.serverUrl) === deploymentKeyFor(serverUrl));
      if (membership === undefined) throw new Error(`No membership matches this Deployment. Memberships held: ${all.map((m) => m.serverUrl).join(', ') || 'none'}`);
      const bindings = logoutBindings(mycoHome).filter((b) => deploymentUrl(b.serverUrl) === serverUrl);
      const runtime = deps.runtime.snapshot(aliases);
      const j: LogoutJournal = {
        version: 1, serverUrl, startedAt: (deps.now ?? Date.now)(), phase: 'revoke', tokenDigest: membershipTokenDigest(membership),
        machineId: membership.machineId, bindings: [...new Map([...(saved?.bindings ?? []), ...bindings].map((binding) => [path.resolve(binding.root), binding])).values()], defaultUrl: readDefaultDeployment(mycoHome)?.serverUrl ?? null,
        ...runtime,
      };
      saveJournal(j, mycoHome);
      return j;
    }, mycoHome);
    const advance = async (phase: LogoutPhase): Promise<void> => {
      journal = { ...journal, phase };
      saveJournal(journal, mycoHome);
      await deps.checkpoint?.(phase);
    };
    if (journal.phase === 'revoke') {
      journal.revoke = await revoke(journal, opts.mode, deps, mycoHome);
      await deps.checkpoint?.('revoked');
      await advance('local');
    }
    if (journal.phase === 'local') {
      withRegistryLock(() => {
        removeDeploymentForLogout(serverUrl, journal.tokenDigest, journal.bindings, mycoHome, () => {
          deps.runtime.removeWorkers(journal.workerUrls);
        }, deps.afterBindingsRemoved, journal.startedAt);
        const surviving = memberships(mycoHome);
        reconcileDefaultDeployment(serverUrl, surviving.length === 1 ? surviving[0].serverUrl : null, mycoHome);
      }, mycoHome);
      await advance('config');
    }
    if (journal.phase === 'config') {
      withRegistryLock(() => {
        if (readDeploymentMembershipResult(serverUrl, mycoHome).status !== 'missing') throw new Error('This Deployment was signed in again during logout; configuration was left in place');
        const surviving = memberships(mycoHome);
        const next = readDefaultDeployment(mycoHome)?.serverUrl ?? null;
        deps.runtime.reconcile(serverUrl, next, surviving.length > 0, journal.bindings, logoutBindings(mycoHome));
      }, mycoHome);
      await advance('done');
    }
    return withRegistryLock(() => {
      const connectedRoots = new Set(logoutBindings(mycoHome).map((binding) => path.resolve(binding.root)));
      const leftRoots = journal.bindings.map((binding) => binding.root)
        .filter((root) => !connectedRoots.has(path.resolve(root)) && isLeft(rootKeyFor(root, mycoHome), mycoHome));
      const report: LogoutReport = {
        serverUrl, revoked: journal.revoke === 'revoked', machineId: journal.machineId, leftRoots, defaultUrl: readDefaultDeployment(mycoHome)?.serverUrl ?? null,
        survivors: memberships(mycoHome).map((m) => m.serverUrl), keptSpool: spoolReport(serverUrl, mycoHome), runner: journal.runner,
      };
      fs.rmSync(logoutJournalPath(serverUrl, mycoHome), { force: true });
      lease.lock.release();
      fs.rmSync(lock, { force: true });
      return report;
    }, mycoHome);
  } finally {
    lease.lock.release();
  }
}
