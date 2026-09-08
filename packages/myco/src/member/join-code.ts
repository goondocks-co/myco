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
import { acquireRegistryLock, readDeploymentMembership, writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION } from './registry.js';

/** How long a hook waits for the one holding the registry lock to finish redeeming the code. */
const JOIN_WAIT_MS = 10_000;
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
  opts: { fetch?: typeof fetch; machineId?: string; runtimeKind?: string; forProject?: boolean } = {},
): Promise<ExchangeResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${code.serverUrl}/members/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
 * for the first, then finds the membership and captures on it, so both land.
 *
 * A wait that times out captures nothing and says so once. It does not fall
 * through to its own exchange — that is the race this exists to prevent.
 */
export async function ensureJoinedFromCode(
  opts: {
    env?: NodeJS.ProcessEnv; mycoHome?: string; root?: string; fetch?: typeof fetch;
    now?: () => number; machineId?: string; waitMs?: number; sleep?: (ms: number) => Promise<void>;
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
  if (readDeploymentMembership(parsed.serverUrl, mycoHome) !== null) return;

  const lock = acquireRegistryLock(mycoHome);
  if (!lock.acquired) {
    await awaitMembership(parsed.serverUrl, mycoHome, opts);
    return;
  }
  try {
    // Re-read inside the lock: a hook that held it before this one may already have joined.
    if (readDeploymentMembership(parsed.serverUrl, mycoHome) !== null) return;
    const exchange = await exchangeJoinCode(parsed, {
      fetch: opts.fetch, machineId: opts.machineId, runtimeKind: 'sandbox', forProject: true,
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
 * Wait for the hook holding the lock to publish a membership, up to `waitMs`.
 *
 * The deadline reads the wall clock, never the caller's injected one. An
 * injected clock stamps records and can stand still; a wait measured on a clock
 * that stands still never ends.
 */
async function awaitMembership(
  serverUrl: string, mycoHome: string,
  opts: { waitMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const deadline = Date.now() + (opts.waitMs ?? JOIN_WAIT_MS);
  while (Date.now() < deadline) {
    await sleep(JOIN_POLL_MS);
    if (readDeploymentMembership(serverUrl, mycoHome) !== null) return;
  }
  stderr('another hook is still redeeming the join code; no capture this time');
}
