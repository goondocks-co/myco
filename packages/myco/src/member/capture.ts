/**
 * The one capture path every hook runs: read the normalized input, resolve
 * the declared credential, build the envelope(s), append them to the session
 * spool FIRST, drain under the hook's own budget, then write the hook
 * response. A hook's `main()` is a thin call into `runMemberHook`.
 *
 * Recall sits between the append and the drain: whatever a hook asks the server
 * to serve it, capture is already on disk when the call goes out, so nothing a
 * server says or fails to say can cost a record.
 */
import fs from 'node:fs';
import { readHookInput } from '../hooks/input.js';
import type { NormalizedHookInput } from '../hooks/normalize.js';
import { writeHookResponse, type HookResponse } from '../hooks/response.js';
import { canStartRequest, clippedRequestBudget, resolveHookBudget, type HookBudget } from './budget.js';
import { resolveMycoHome } from '../paths/home.js';
import { parseCredentialFlag, resolveCredential, resolveMemberProjectRoot, type CredentialRecord, type CredentialSource } from './credential.js';
import { ensureJoinedFromCode, joinCodePresent } from './join-code.js';
import type { EnvelopeContext, OutboundEvent } from './envelope.js';
import { refreshDue, refreshMemberCredential, refreshableRoot, rotatedCredential } from './refresh.js';
import { applySpoolRetention } from './retention.js';
import type { SessionState } from './session-state.js';
import { MemberSpool } from './spool.js';
import { ServerClient, type ClientRecord, type FetchLike } from './transport.js';

export interface HookMainOptions {
  /** The declared credential source; read from `--credential` on argv when absent. */
  credential?: CredentialSource | null;
  fetch?: FetchLike;
  argv?: readonly string[];
  now?: () => number;
  /** When the hook's budget clock started; defaults to this process's start. */
  startedAt?: number;
  /** The environment a join code is read from; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
}

/** What a hook handler receives once input and credential are in hand. */
export interface HookRun {
  hookName: string;
  input: NormalizedHookInput;
  sessionId: string;
  agent: string;
  credential: CredentialRecord;
  spool: MemberSpool;
  ctx: EnvelopeContext;
  budget: HookBudget;
  client: ServerClient;
  now: () => number;
  argv: readonly string[];
}

export interface HookOutcome {
  events: OutboundEvent[];
  /**
   * The receipts for `events` — the prompt hashes, plan hashes, attachment
   * keys and transcript parsed size that stop them being derived twice.
   * Applied WITH the append, under one hold of the session's buffer lock: a
   * handler that writes a receipt itself makes a crash before the append a
   * permanent loss, because nothing re-derives an event already receipted.
   *
   * The closure runs INSIDE that lock, which `withFileLockSync` takes as a
   * blocking `LOCK_EX` on a fresh fd. It must therefore touch no
   * `…SessionState` helper and nothing else that takes the same lock: a second
   * acquisition from this process blocks on the first and the hook hangs until
   * the harness kills it. Mutate the state object it is handed, and nothing
   * else.
   */
  record?: (state: SessionState) => void;
  response?: HookResponse;
  /**
   * What the server serves this hook, asked for AFTER the events and their
   * receipts are on disk and before the drain. Its answer, when it gives one,
   * replaces `response`.
   *
   * Capture is durable before any server call reaches this seam, so a slow, a
   * failing or a hostile answer costs the served block alone: the events stay
   * spooled, the receipts stay written, and the response the handler already
   * built still reaches the harness.
   *
   * It runs only on a hook that drains and only when the offline latch admits a
   * dial, so it never spends a budget the spool has already decided is wasted.
   */
  context?: (run: HookRun) => Promise<HookResponse | undefined>;
  /** Dial even while the offline latch is set (Stop/SessionEnd always probe). */
  probe?: boolean;
  /** Work after the spool drain, inside the budget (transcript shipping). */
  afterDrain?: (run: HookRun) => Promise<void>;
}

/** The harness event name the input carries, when the harness sends one (`hook_event_name`). */
const harnessEventOf = (input: NormalizedHookInput): string | undefined =>
  typeof input.raw.hook_event_name === 'string' ? input.raw.hook_event_name : undefined;

/**
 * The directory this hook invocation belongs to: the directory the harness
 * names in its payload when that directory is on this machine, else this
 * process's own — the launch preamble has already anchored that to the
 * harness's project dir, so a symbiont whose payload names no directory still
 * resolves the project it fired in.
 *
 * It decides BOTH the project root the credential is keyed on and the Myco home
 * that root's membership lives in, so the two can never disagree. A
 * GUI-launched agent inherits no `MYCO_HOME` from any shell; the home comes
 * from the project's `.myco/runtime.home` pin, found by walking up from here.
 */
function hookCwd(input: NormalizedHookInput): string {
  const named = input.raw.cwd;
  if (typeof named !== 'string' || named.length === 0) return process.cwd();
  try {
    // `stat`, not `lstat`: a checkout reached through a symlinked path is an
    // ordinary way to work, and this only decides WHERE to look. The pin file
    // found at the end of that walk is what decides anything, and that read is
    // an `lstat` (`paths/pin-trust.ts`).
    return fs.statSync(named).isDirectory() ? named : process.cwd();
  } catch {
    return process.cwd();
  }
}

export async function runMemberHook(
  hookName: string,
  opts: HookMainOptions,
  handle: (run: HookRun) => Promise<HookOutcome> | HookOutcome,
): Promise<void> {
  let symbiont: string | undefined;
  let response: HookResponse = {};
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    const sessionId = input.sessionId;
    if (!sessionId) return;

    const argv = opts.argv ?? process.argv;
    const source = opts.credential === undefined ? parseCredentialFlag(argv) : opts.credential;

    const now = opts.now ?? Date.now;
    const budget = resolveHookBudget(input.agent, hookName, { hookEventName: harnessEventOf(input), startedAt: opts.startedAt });

    // One directory decides the project root and the home its membership is
    // held under, so a pinned project's hooks read the registry that holds it.
    const cwd = hookCwd(input);
    const mycoHome = resolveMycoHome({ cwd });

    // A sandbox arrives holding a join code and nothing else; this turns it into a
    // registry entry on disk so the resolve below finds a credential like any other
    // run. It sits under the budget: the exchange is a network call the harness will
    // kill this process for outrunning. The root is the one `resolveCredential`
    // reads, so the entry it writes is the entry that resolve looks for — and it is
    // resolved only when there is a code to redeem, which is never on an ordinary run.
    if (joinCodePresent(opts.env)) {
      await ensureJoinedFromCode({
        env: opts.env, fetch: opts.fetch as typeof fetch | undefined, root: resolveMemberProjectRoot(cwd), mycoHome, budget,
      });
    }
    const credential = resolveCredential(source, { cwd, mycoHome, invokedBy: `hook ${hookName}` });
    if (!credential) return;

    const spool = new MemberSpool(credential.projectId, { mycoHome });
    const ctx: EnvelopeContext = { agent: input.agent, sessionId, stage: spool.stagerFor(sessionId), now };
    const client = new ServerClient(credential, opts.fetch ?? globalThis.fetch);
    const run: HookRun = { hookName, input, sessionId, agent: input.agent, credential, spool, ctx, budget, client, now, argv };

    const outcome = await handle(run);
    response = outcome.response ?? {};
    spool.appendAndRecord(sessionId, outcome.events, outcome.record, now());
    if (budget.drains) {
      // The seam is a dial like any other: a hook that never drains never asks
      // the server for anything, and a latched spool costs one connect timeout
      // per backoff window rather than one per prompt.
      if (outcome.context && spool.shouldDial(now(), outcome.probe)) {
        try {
          const served = await outcome.context(run);
          if (served !== undefined) response = served;
        } catch (error) {
          process.stderr.write(`[myco] ${hookName}: context skipped (${(error as Error).message})\n`);
        }
      }
      const fetchImpl = opts.fetch ?? globalThis.fetch;
      const root = refreshableRoot(credential);
      // A 401 on a live send: another hook may have rotated this root's token, so the registry is re-read and the record retried once.
      const recovery = root === null ? {} : {
        onUnauthorized: async (): Promise<ClientRecord | null> => rotatedCredential(root, credential, mycoHome),
        clientFor: (record: ClientRecord) => new ServerClient(record, fetchImpl),
      };
      const drained = await spool.drainSession(sessionId, client, budget, { force: outcome.probe, now, ...recovery });
      if (outcome.afterDrain) await outcome.afterDrain(run);
      // Probing hooks (Stop/SessionEnd) also apply spool retention for the
      // project; a drain that delivered everything also lets go of the state
      // of sessions delivered long ago.
      if (outcome.probe) applySpoolRetention(spool, now(), { delivered: drained.endedBy === 'drained' && drained.remaining === 0 });
      // Registry-sourced credentials rotate after the hook's main work, inside what remains of the budget; env-sourced ones never do.
      if (root !== null && refreshDue(credential, now()) && canStartRequest(budget, now())) {
        await refreshMemberCredential(root, { mycoHome, fetch: fetchImpl, now, budget: clippedRequestBudget(budget, now()) });
      }
    }
  } catch (error) {
    process.stderr.write(`[myco] ${hookName} error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, hookName, response);
  }
}
