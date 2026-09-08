/**
 * Join codes — the one string that carries a Deployment and an invitation
 * together, and the exchange that turns it into a member credential.
 *
 * The shape is `https://<deployment>/join#<key>`. The key rides in the URL
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
import { getMachineId } from '../machine-id.js';
import { resolveMycoHome } from '../paths/home.js';
import { ENROLLMENT_KEY_PATTERN, ENV_JOIN_CODE, JOIN_PATH } from './constants.js';
import { isHttpsUrl, isLoopbackHttpUrl } from './credential.js';
import { acquireRegistryLock, readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION } from './registry.js';
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
  if (!isHttpsUrl(url.href) && !isLoopbackHttpUrl(url.href)) return { error: 'not_https' };
  if (url.pathname.replace(/\/+$/, '') !== JOIN_PATH) return { error: 'wrong_path' };
  const key = url.hash.startsWith('#') ? url.hash.slice(1) : '';
  if (key.length === 0) return { error: 'no_key' };
  if (!ENROLLMENT_KEY_PATTERN.test(key)) return { error: 'key_grammar' };
  return { serverUrl: url.origin, key };
}

/** How a join code names its refusals to a person reading a terminal. */
export const JOIN_CODE_REFUSALS: Record<JoinCodeRefusal, string> = {
  not_a_url: 'that is not a URL',
  not_https: 'a join link must be https',
  wrong_path: `a join link path must be ${JOIN_PATH}`,
  no_key: 'that link carries no invitation',
  key_grammar: 'that link does not carry an invitation key',
};

/** Whether this runtime carries a join code at all. The one read an ordinary run makes: no code, no filesystem work, no exchange. */
export const joinCodePresent = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env[ENV_JOIN_CODE]?.trim());

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
export async function exchangeJoinCode(
  code: JoinCode,
  opts: { fetch?: typeof fetch; machineId?: string; runtimeKind?: string; forProject?: boolean; timeoutMs?: number } = {},
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
        forProject: opts.forProject === true ? true : undefined,
      }),
    });
  } catch (error) {
    return { ok: false, code: 'unreachable', reason: (error as Error).message };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'unreadable', reason: `the Deployment answered ${response.status} with no JSON` };
  }
  if (body.joined !== true) {
    return { ok: false, code: String(body.code ?? 'refused'), reason: String(body.reason ?? `the Deployment answered ${response.status}`) };
  }
  return {
    ok: true,
    answer: {
      memberId: String(body.memberId), token: String(body.token), tokenId: String(body.tokenId),
      expiresAt: Number(body.expiresAt), role: String(body.role),
      projectId: typeof body.projectId === 'string' ? body.projectId : null,
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
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  if (joined(parsed.serverUrl, mycoHome, opts.root)) return;

  const lock = acquireRegistryLock(mycoHome);
  if (!lock.acquired) {
    await awaitJoin(parsed.serverUrl, mycoHome, opts);
    return;
  }
  try {
    // Re-read inside the lock: a hook that held it before this one may already have joined.
    if (joined(parsed.serverUrl, mycoHome, opts.root)) return;
    const exchange = await exchangeJoinCode(parsed, {
      fetch: opts.fetch, machineId: opts.machineId, runtimeKind: 'sandbox', forProject: true,
      timeoutMs: opts.budget === undefined ? undefined : clippedRequestBudget(opts.budget).requestTimeoutMs,
    });
    if (!exchange.ok) {
      stderr(`join code refused (${exchange.code}) — ${exchange.reason}; no capture`);
      return;
    }
    recordJoinAnswer(parsed, exchange.answer, {
      mycoHome, root: opts.root, now: opts.now?.() ?? Date.now(), machineId: opts.machineId, locked: true,
    });
  } finally {
    lock.lock.release();
  }
}

/**
 * Whether this machine already holds what a hook at `root` needs.
 *
 * A project binding is what `resolveCredential` reads, and `writeRegistryEntry`
 * writes the membership and the binding as two separate renames — so a reader
 * that stops at the membership can return between them and find no binding. When
 * a root is known this asks for the binding; the membership alone answers only
 * where there is no project to bind.
 */
function joined(serverUrl: string, mycoHome: string, root: string | undefined): boolean {
  if (root !== undefined) return readRegistryEntry(root, mycoHome) !== null;
  return readDeploymentMembership(serverUrl, mycoHome) !== null;
}

/**
 * Wait for the hook holding the lock to finish, up to the hook's own budget.
 *
 * The deadline reads the wall clock, never the caller's injected one. An
 * injected clock stamps records and can stand still; a wait measured on a clock
 * that stands still never ends.
 */
async function awaitJoin(
  serverUrl: string, mycoHome: string,
  opts: { root?: string; waitMs?: number; budget?: HookBudget; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const budgeted = opts.budget === undefined ? JOIN_WAIT_CAP_MS : Math.max(0, remainingMs(opts.budget));
  const window = Math.min(opts.waitMs ?? JOIN_WAIT_CAP_MS, budgeted);
  const deadline = Date.now() + window;
  while (Date.now() < deadline) {
    await sleep(JOIN_POLL_MS);
    if (joined(serverUrl, mycoHome, opts.root)) return;
  }
  stderr('another hook is still redeeming the join code; no capture this time');
}
