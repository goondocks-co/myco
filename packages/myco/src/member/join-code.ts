/**
 * Join codes — the one string that carries a Deployment and an invitation
 * together, and the exchange that turns it into a member credential.
 *
 * The shape is `https://<deployment>/join#<key>` (or `http://` on this
 * machine's loopback, where a laptop serves itself). The key rides in the URL
 * fragment, which a browser never puts on the wire: a link pasted into an
 * address bar reaches the Deployment with the secret still on the clipboard and
 * not in an access log. The origin and the credential travel together, so a
 * sandbox needs one environment variable rather than a server URL, a token and
 * a project id that have to agree.
 *
 * One string, two carriers. A person is handed it as a link and runs
 * `myco login`; a sandbox is handed it as `MYCO_JOIN_CODE` and exchanges it on
 * its first hook. Both land here.
 *
 * The exchange is serialized under the registry lock, held across the network
 * call. A join code is single-use, so two hooks starting together would
 * otherwise race it: one would win and one would be told the code is spent, with
 * no credential and no capture. Here the second waits for the first, then reads
 * the membership it wrote and captures on that. Both land.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMachineId } from '../machine-id.js';
import { resolveMachineIdPath } from '../paths/home.js';
import { memberHomeFor } from './home-for-folder.js';
import { MACHINE_IDENTITY_NOTE, REJOIN_HINT } from '@goondocks/myco-shared/member-protocol';
import { ENROLLMENT_KEY_PATTERN, ENV_JOIN_CODE, JOIN_PATH } from './constants.js';
import { admitMemberServerUrl, MEMBER_SERVER_URL_RULE } from './server-url.js';
import { acquireRegistryLock, deploymentUrl, readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION } from './registry.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';
import { clippedRequestBudget, remainingMs, type HookBudget } from './budget.js';

/**
 * The longest a hook waits for the one holding the registry lock, when nothing
 * bounds it more tightly. A hook that carries a budget is clipped to that
 * instead: a wait outliving the harness timeout is a wait nothing ever reads.
 */
const JOIN_WAIT_CAP_MS = 10_000;
/** How often it looks while it waits. */
const JOIN_POLL_MS = 100;

const stderr = (line: string): void => { process.stderr.write(`[myco] member: ${line}\n`); };

/** A join code split into the two halves it carries. */
export interface JoinCode {
  serverUrl: string;
  key: string;
}

/** The role an invitation grants a member who administers the Deployment, and so may run its work. */
export const ADMIN_ROLE = 'admin';

/** What the Deployment answers a spent code with. */
export interface JoinAnswer {
  memberId: string;
  token: string;
  tokenId: string;
  expiresAt: number;
  role: string;
  projectId: string | null;
}

export type JoinCodeRefusal =
  | 'not_a_url'
  | 'not_https'
  | 'wrong_path'
  | 'no_key'
  | 'key_grammar';

/**
 * The two halves of a join code, or the name of what is wrong with it.
 *
 * Every check is on the string alone. A code that cannot be parsed never
 * reaches the network, so a typo costs no request and spends nothing.
 */
export function parseJoinCode(value: string): JoinCode | { error: JoinCodeRefusal } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: 'not_a_url' };
  }
  if (!admitMemberServerUrl(url.href)) return { error: 'not_https' };
  if (url.pathname.replace(/\/+$/, '') !== JOIN_PATH) return { error: 'wrong_path' };
  const key = url.hash.startsWith('#') ? url.hash.slice(1) : '';
  if (key.length === 0) return { error: 'no_key' };
  if (!ENROLLMENT_KEY_PATTERN.test(key)) return { error: 'key_grammar' };
  return { serverUrl: url.origin, key };
}

/** How a join code names its refusals to a person reading a terminal. */
export const JOIN_CODE_REFUSALS: Record<JoinCodeRefusal, string> = {
  not_a_url: 'that is not a URL',
  not_https: `a join link must be ${MEMBER_SERVER_URL_RULE}`,
  wrong_path: `a join link path must be ${JOIN_PATH}`,
  no_key: 'that link carries no invitation',
  key_grammar: 'that link does not carry an invitation key',
};

export type ExchangeResult =
  | { ok: true; answer: JoinAnswer }
  | { ok: false; code: string; reason: string };

/**
 * Spend the code at the Deployment, once.
 *
 * `forProject` is the caller saying it cannot work without a bound Project — a
 * sandbox, which has no local configuration to fall back on. The Deployment then
 * refuses a code carrying none rather than answering one the caller cannot use,
 * and leaves it unspent so an operator can bind a Project and hand the same code
 * over.
 */
/** The grammar the Deployment admits a runtime label in. */
const RUNTIME_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A host name as a runtime label: the first DNS label, each run of spaces a hyphen, characters outside the grammar
 * dropped, cut to 64. Undefined when nothing is left, and the join then carries no label.
 */
export function runtimeLabelOf(hostname: string): string | undefined {
  const label = (hostname.split('.')[0] ?? '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  return RUNTIME_LABEL.test(label) ? label : undefined;
}

export async function exchangeJoinCode(
  code: JoinCode,
  opts: { fetch?: typeof fetch; machineId?: string; runtimeKind?: string; runtimeLabel?: string; forProject?: boolean; timeoutMs?: number } = {},
): Promise<ExchangeResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${code.serverUrl}/members/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A hook is killed at its harness timeout. An exchange without a deadline of its
      // own outlives the process that started it, and the key it spent is unrecorded.
      signal: opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs),
      body: JSON.stringify({
        key: code.key,
        machineId: opts.machineId ?? getMachineId(),
        runtimeKind: opts.runtimeKind,
        runtimeLabel: opts.runtimeLabel,
        forProject: opts.forProject === true ? true : undefined,
      }),
    });
  } catch (error) {
    return { ok: false, code: 'unreachable', reason: (error as Error).message };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  // A front that is not the Deployment — a proxy's refusal, an empty body — answers no object.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'unreadable', reason: `the Deployment answered ${response.status} with no JSON object` };
  }
  const answer = body as Record<string, unknown>;
  if (answer.joined !== true) {
    return { ok: false, code: String(answer.code ?? 'refused'), reason: String(answer.reason ?? `the Deployment answered ${response.status}`) };
  }
  return {
    ok: true,
    answer: {
      memberId: String(answer.memberId), token: String(answer.token), tokenId: String(answer.tokenId),
      expiresAt: Number(answer.expiresAt), role: String(answer.role),
      projectId: typeof answer.projectId === 'string' ? answer.projectId : null,
    },
  };
}

/** Record what the exchange answered: the membership always, and a project binding only when the code named a Project and a root is known. */
export function recordJoinAnswer(
  code: JoinCode, answer: JoinAnswer, opts: { mycoHome?: string; root?: string; now?: number; machineId?: string; locked?: boolean } = {},
): void {
  const now = opts.now ?? Date.now();
  const machineId = opts.machineId ?? getMachineId();
  const membership = {
    serverUrl: code.serverUrl, token: answer.token, tokenId: answer.tokenId, memberId: answer.memberId,
    expiresAt: answer.expiresAt, machineId, joinedAt: now, updatedAt: now,
  };
  if (answer.projectId === null || opts.root === undefined) {
    writeDeploymentMembership(membership, { mycoHome: opts.mycoHome, locked: opts.locked });
    return;
  }
  writeRegistryEntry(
    { version: REGISTRY_VERSION, ...membership, projectId: answer.projectId, root: opts.root },
    { mycoHome: opts.mycoHome, locked: opts.locked },
  );
}

/**
 * Ensure this machine holds a credential for the Deployment its join code names,
 * exchanging the code once if it does not. A no-op when `MYCO_JOIN_CODE` is
 * unset, which is every run outside a sandbox.
 *
 * The lock is held ACROSS the exchange, the way the refresh path holds it across
 * its dial. A join code is single-use: two hooks exchanging it at once would
 * leave one of them holding a refusal and no credential. Here the second waits
 * for the first, then finds what it wrote and captures on that. Both land.
 *
 * A root this home already binds to ANOTHER Deployment is left as it is and the
 * code is not presented: redeeming it would rebind the root, and every other
 * process sharing this home — a laptop whose `~/.myco` a devcontainer mounts —
 * would then capture to the code's Deployment instead of its own.
 *
 * A refusal the code cannot recover from (the invitation spent, expired,
 * revoked or unknown, or this machine's identity held by another member) is
 * recorded under the home, and later hooks name it rather than dial again.
 *
 * Everything here is spent from the hook's own budget. The exchange carries a
 * deadline and the wait is clipped to what the hook has left, so neither
 * outlives the process the harness is about to kill — a wait that outlives its
 * hook is a wait whose answer nobody reads.
 */
export async function ensureJoinedFromCode(
  opts: {
    env?: NodeJS.ProcessEnv; mycoHome?: string; root?: string; fetch?: typeof fetch;
    now?: () => number; machineId?: string; budget?: HookBudget;
    waitMs?: number; sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const raw = (opts.env ?? process.env)[ENV_JOIN_CODE]?.trim();
  if (!raw) return;
  const parsed = parseJoinCode(raw);
  if ('error' in parsed) {
    stderr(`${ENV_JOIN_CODE} — ${JOIN_CODE_REFUSALS[parsed.error]}; no capture`);
    return;
  }
  const mycoHome = opts.mycoHome ?? memberHomeFor(opts.root ?? process.cwd(), opts.env).home;
  if (settled(parsed, mycoHome, opts.root)) return;
  const machineId = opts.machineId ?? getMachineId();
  const refused = readJoinRefusal(parsed, machineId, mycoHome);
  if (refused !== null) {
    stderr(`${refusalLine(refused, mycoHome)} (recorded ${new Date(refused.refusedAt).toISOString()}; not retried)`);
    return;
  }

  const lock = acquireRegistryLock(mycoHome);
  if (!lock.acquired) {
    await awaitJoin(parsed, mycoHome, opts);
    return;
  }
  try {
    // Re-read inside the lock: a hook that held it before this one may already have joined.
    if (settled(parsed, mycoHome, opts.root)) return;
    const exchange = await exchangeJoinCode(parsed, {
      fetch: opts.fetch, machineId, runtimeKind: 'sandbox', forProject: true,
      timeoutMs: opts.budget === undefined ? undefined : clippedRequestBudget(opts.budget).requestTimeoutMs,
    });
    if (!exchange.ok) {
      const refusal: JoinRefusal = { code: exchange.code, reason: exchange.reason, serverUrl: parsed.serverUrl, machineId, refusedAt: opts.now?.() ?? Date.now() };
      if (TERMINAL_JOIN_REFUSALS.has(exchange.code)) writeJoinRefusal(parsed, refusal, mycoHome);
      stderr(refusalLine(refusal, mycoHome));
      return;
    }
    recordJoinAnswer(parsed, exchange.answer, {
      mycoHome, root: opts.root, now: opts.now?.() ?? Date.now(), machineId, locked: true,
    });
  } finally {
    lock.lock.release();
  }
}

/** Where this home stands for a join code at `root`. */
type JoinState = { state: 'joined' } | { state: 'absent' } | { state: 'elsewhere'; boundTo: string };

/**
 * Whether this machine already holds what a hook at `root` needs, from the
 * Deployment the code names.
 *
 * A project binding is what `resolveCredential` reads, and `writeRegistryEntry`
 * writes the membership and the binding as two separate renames — so a reader
 * that stops at the membership can return between them and find no binding. When
 * a root is known this asks for the binding; the membership alone answers only
 * where there is no project to bind. A binding to another Deployment is not
 * this code's membership, and is named as such.
 */
function joinState(code: JoinCode, mycoHome: string, root: string | undefined): JoinState {
  if (root === undefined) return readDeploymentMembership(code.serverUrl, mycoHome) !== null ? { state: 'joined' } : { state: 'absent' };
  const entry = readRegistryEntry(root, mycoHome);
  if (entry === null) return { state: 'absent' };
  return deploymentUrl(entry.serverUrl) === deploymentUrl(code.serverUrl) ? { state: 'joined' } : { state: 'elsewhere', boundTo: entry.serverUrl };
}

/** True when nothing is left to redeem: the root is joined to the code's Deployment, or to another one, which is said and left alone. */
function settled(code: JoinCode, mycoHome: string, root: string | undefined): boolean {
  const held = joinState(code, mycoHome, root);
  if (held.state === 'elsewhere') {
    stderr(`${ENV_JOIN_CODE} names ${code.serverUrl}, but ${root} is joined to ${held.boundTo} under ${mycoHome}; the code is not redeemed. `
      + 'Give the sandbox a MYCO_HOME of its own');
  }
  return held.state !== 'absent';
}

/** The Deployment's refusals a retry of the same code, from the same identity, cannot turn into a membership. */
const TERMINAL_JOIN_REFUSALS: ReadonlySet<string> = new Set([
  'identity_claimed', 'enrollment_unknown', 'enrollment_used', 'enrollment_expired', 'enrollment_revoked',
]);

/** A refusal recorded so later hooks do not dial the Deployment with the same code again. */
export interface JoinRefusal {
  code: string;
  reason: string;
  serverUrl: string;
  machineId: string;
  refusedAt: number;
}

const JOIN_REFUSALS_DIRNAME = 'join-refusals';

/** Where a home records the join refusals no retry can change. */
export function joinRefusalsDir(mycoHome: string): string {
  return path.join(memberRoot(mycoHome), JOIN_REFUSALS_DIRNAME);
}

/** Forget every recorded join refusal, so the next hook presents its code again. True when there was a record to forget. */
export function clearJoinRefusals(mycoHome: string): boolean {
  const dir = joinRefusalsDir(mycoHome);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The record for this code from this identity: a new identity, or a new code, is asked afresh. */
function joinRefusalPath(code: JoinCode, machineId: string, mycoHome: string): string {
  const key = crypto.createHash('sha256').update(`${deploymentUrl(code.serverUrl)}\n${code.key}\n${machineId}`).digest('hex').slice(0, 32);
  return path.join(joinRefusalsDir(mycoHome), `${key}.json`);
}

export function readJoinRefusal(code: JoinCode, machineId: string, mycoHome: string): JoinRefusal | null {
  const read = readPrivateJson<JoinRefusal>(joinRefusalPath(code, machineId, mycoHome));
  return read.ok ? read.value : null;
}

function writeJoinRefusal(code: JoinCode, refusal: JoinRefusal, mycoHome: string): void {
  const file = joinRefusalPath(code, refusal.machineId, mycoHome);
  ensureMemberDir(path.dirname(file), mycoHome);
  writePrivateFileAtomic(file, `${JSON.stringify(refusal)}\n`);
}

/** The one line a refusal is told in, with the remedy where there is one. */
function refusalLine(refusal: JoinRefusal, mycoHome: string): string {
  if (refusal.code === 'identity_claimed') {
    return `join code refused (identity_claimed): this machine's identity ${refusal.machineId} already belongs to another member of ${refusal.serverUrl}. `
      + `A sandbox needs an identity of its own: run it with its own MYCO_HOME holding a distinct machine_id (this process reads ${resolveMachineIdPath()}). `
      + `If this machine is that member's, ${REJOIN_HINT}. ${MACHINE_IDENTITY_NOTE}. `
      + `To present this code again, delete ${joinRefusalsDir(mycoHome)} (\`myco member leave --purge\` does too) and the next hook asks again; no capture`;
  }
  return `join code refused (${refusal.code}) — ${refusal.reason}; no capture`;
}

/**
 * Wait for the hook holding the lock to finish, up to the hook's own budget.
 *
 * The deadline reads the wall clock, never the caller's injected one. An
 * injected clock stamps records and can stand still; a wait measured on a clock
 * that stands still never ends.
 */
async function awaitJoin(
  code: JoinCode, mycoHome: string,
  opts: { root?: string; waitMs?: number; budget?: HookBudget; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const budgeted = opts.budget === undefined ? JOIN_WAIT_CAP_MS : Math.max(0, remainingMs(opts.budget));
  const window = Math.min(opts.waitMs ?? JOIN_WAIT_CAP_MS, budgeted);
  const deadline = Date.now() + window;
  while (Date.now() < deadline) {
    await sleep(JOIN_POLL_MS);
    if (settled(code, mycoHome, opts.root)) return;
  }
  stderr('another hook is still redeeming the join code; no capture this time');
}
