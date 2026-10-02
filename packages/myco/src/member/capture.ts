/**
 * The one capture path every hook runs (#1561): read the normalized input, resolve the declared credential, build the
 * envelope(s), append them to the session spool, render the hook's answer from what this machine holds, kick the
 * project's member helper, and write the response. Nothing on the way waits on the network: the helper delivers the
 * spool, renews the credential and fetches the context the next hooks render, in its own process.
 *
 * A hook that ends a turn or a session and cannot leave the delivery to a helper (`--ship inline`, a sandbox whose
 * process ends with the hook; or a helper that could not be started apart from it, `shipsInline`) runs the helper's
 * pass itself, inside its own budget, before it answers.
 */
import { machinePlanDirs } from './machine-settings.js';
import fs from 'node:fs';
import { readHookInput } from '../hooks/input.js';
import type { NormalizedHookInput } from '../hooks/normalize.js';
import { writeHookResponse, type HookResponse } from '../hooks/response.js';
import { resolveHookBudget, type HookBudget } from './budget.js';
import { resolveMycoHome } from '../paths/home.js';
import { parseCredentialFlag, redeemsJoinCode, resolveCredential, resolveMemberProjectRoot, type CredentialRecord, type CredentialSource } from './credential.js';
import { withAsk, type ContextAsk } from './context-cache.js';
import { deliveryNotice, withNotice } from './delivery-notice.js';
import { autoJoinHold, LEFT_ALONE, type AutoJoinHold } from './auto-join-hook.js';
import { appendPending, appendPendingTurnEnd } from './pending.js';
import { flushHeldCapture } from './held.js';
import { ensureJoinedFromCode } from './join-code.js';
import type { EnvelopeContext, OutboundEvent } from './envelope.js';
import { kickHelper, markWork, runHelper, shipsInline, type KickOutcome, type KickReason } from './helper.js';
import { hookDelivered, type HookAppended } from './backlog.js';
import { helperPass } from './helper-pass.js';
import { refreshableRoot } from './refresh.js';
import { readRegistryEntry, REGISTRY_VERSION, type RegistryEntry } from './registry.js';
import { getMachineId } from '../machine-id.js';
import type { SessionState } from './session-state.js';
import { MemberSpool, turnEndIdentity, type TurnEndMark } from './spool.js';
import type { FetchLike } from './transport.js';
import type { DetachedSpawn } from '../runtime/spawn-detached.js';

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
  /** How the member helper is started apart from the hook; defaults to a detached process. */
  helperSpawn?: DetachedSpawn;
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
  /** The hook's own time: what reading the transcript and the plan files may spend, and what an inline pass may. */
  budget: HookBudget;
  now: () => number;
  argv: readonly string[];
  /** The home this run's membership is held under, resolved from the hook's own directory: every file the run reads or writes for that membership lives here. */
  mycoHome: string;
  /** The extra plan folders the Deployment holds for this machine, read from this run's own home; each reader asks here rather than naming a home. */
  machinePlanDirs: () => string[];
  /**
   * Set for a run in a repository that is joining a project and has none yet (`auto-join-hook.ts`): its capture goes
   * to the repository's pending spool, nothing is dialled, and nothing keyed to a project is derived.
   */
  pending?: boolean;
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
  /** What the member helper is to fetch for the hooks after this one, recorded with the records. */
  ask?: ContextAsk;
  /**
   * This hook ends a turn or the session: the kick dials past the offline latch, and a hook that cannot leave the
   * delivery to a helper runs the pass itself.
   */
  ends?: 'turn-end' | 'session-end';
  /**
   * A turn's end the Deployment is to learn of from the transcript lane: a turn-end mark (`.<session>.turns`) naming
   * where the session's transcript stood. Appended after the records.
   */
  turnEnd?: Pick<TurnEndMark, 'slot' | 'transcriptId' | 'atSize'>;
  /**
   * Where the session's own transcript stood when this end hook read it: part of the turn it ends, which an inline
   * end delivers before it exits (`hookDelivered`).
   */
  transcriptAt?: Pick<TurnEndMark, 'transcriptId' | 'atSize'>;
  /**
   * How this hook hands the person a delivery notice, for a hook whose answer
   * the harness shows the agent: the response with the notice added to it.
   * Every hook that has one also prints the notice to stderr.
   */
  notice?: (text: string, response: HookResponse) => HookResponse;
}

/** Whether the hook command asks its turn's and session's end to deliver in-process (`--ship inline`). */
export function shipsInlineFlag(argv: readonly string[]): boolean {
  const i = argv.indexOf('--ship');
  return i !== -1 && argv[i + 1] === 'inline';
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
export function hookCwd(input: NormalizedHookInput): string {
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
    // reads, so the entry it writes is the entry that resolve looks for. The code is
    // presented, which spends it, only when the declared source reads that entry
    // (`redeemsJoinCode`): a single-use code spent on a hook that then resolves
    // elsewhere is a code gone and a machine that never captures.
    const env = opts.env ?? process.env;
    if (redeemsJoinCode(source, env)) {
      await ensureJoinedFromCode({
        env, fetch: opts.fetch as typeof fetch | undefined, root: resolveMemberProjectRoot(cwd), mycoHome, budget,
      });
    }
    // A repository with no connection of its own joins the default Deployment apart from this hook, which meanwhile
    // spools into the repository's pending spool, or, once left, captures nothing. Either way it is no missed membership.
    const unconnected: { answer: AutoJoinHold | typeof LEFT_ALONE | null } = { answer: null };
    // The join's request and kick, run once this hook's capture is appended, each on its own: neither can lose it.
    const afterCapture: Array<() => void> = [];
    const joinSteps = (): void => {
      for (const step of afterCapture.splice(0)) {
        try { step(); } catch { /* the next hook in the repository asks again */ }
      }
    };
    let credential = resolveCredential(source, {
      cwd, env, mycoHome, invokedBy: `hook ${hookName}`,
      claimsUnconnected: (root) => {
        unconnected.answer = autoJoinHold({ root, hookName, agent: input.agent, sessionId, mycoHome, now: now(), env, spawn: opts.helperSpawn, later: (step) => afterCapture.push(step) });
        return unconnected.answer !== null;
      },
    });
    const hold = unconnected.answer === LEFT_ALONE ? null : unconnected.answer;
    if (hold !== null && hold.notice !== null) response = withNotice(hold.notice, response);
    if (credential === null) {
      if (hold === null || hold.spool === null) { joinSteps(); return; }
      credential = hold.credential;
    }

    // A repository connected while its hooks held capture: what they held joins this run's spool first.
    if (hold === null && credential.root !== undefined) flushHeldCapture(credential.root, credential.projectId, { mycoHome, now: now() });
    const spool = hold?.spool ?? new MemberSpool(credential.projectId, { mycoHome });
    const ctx: EnvelopeContext = { agent: input.agent, sessionId, stage: spool.stagerFor(sessionId), now };
    const serverUrl = credential.serverUrl;
    const run: HookRun = {
      hookName, input, sessionId, agent: input.agent, credential, spool, ctx, budget, now, argv, mycoHome,
      machinePlanDirs: () => machinePlanDirs(serverUrl, mycoHome),
      ...(hold !== null ? { pending: true } : {}),
    };

    const outcome = await handle(run);
    response = outcome.response ?? {};
    if (hold !== null && hold.notice !== null) response = withNotice(hold.notice, response);
    const record = outcome.events.length > 0 || outcome.record || outcome.ask ? (state: SessionState) => {
      state.agent ??= input.agent;
      state.hookAt = now();
      // A session id that hooks again after its end has resumed: its transcript waits on turn ends once more.
      if (hookName !== 'session-end') delete state.endedAt;
      outcome.record?.(state);
      if (outcome.ask) state.contextAsks = withAsk(state.contextAsks, outcome.ask);
    } : undefined;
    // Capture held for a repository still joining lands under the repository's lock: in its pending spool, or in the
    // project's spool once the join has connected it. It is delivered once the repository is connected, by the helper
    // its next hook kicks; until then nothing is dialled and no helper is started.
    if (hold !== null) {
      try {
        appendPending(hold.repo, sessionId, outcome.events, record, { mycoHome, now: now() });
        if (outcome.turnEnd !== undefined) appendPendingTurnEnd(hold.repo, sessionId, outcome.turnEnd, undefined, { mycoHome, now: now() });
      } finally {
        joinSteps();
      }
    } else {
      spool.appendAndRecord(sessionId, outcome.events, record, now());
      if (outcome.turnEnd !== undefined) spool.appendTurnEnd(sessionId, outcome.turnEnd, undefined, now());
    }
    joinSteps();

    // Work for the helper: records appended, context asked for, or a turn's or a session's end to deliver.
    if (hold === null && (outcome.events.length > 0 || outcome.ask !== undefined || outcome.ends !== undefined)) {
      const reason: KickReason = outcome.ends ?? 'capture';
      const target = { projectId: credential.projectId, mycoHome, reason };
      // Only a hook declared to read the registry may leave its work to a detached helper. One declared `env` runs in a
      // sandbox, whose processes end with it: its other hooks only append, and its turn's and session's ends deliver
      // in-process. That holds after a join code is redeemed too, though the credential then resolves from the
      // registry: what the command declares says where the hook runs, what it resolves only says what it holds.
      const detachable = source === 'registry';
      const appended: HookAppended = {
        eventIds: outcome.events.map((event) => event.envelope.eventId),
        ...(outcome.turnEnd !== undefined ? { turnEnd: turnEndIdentity(outcome.turnEnd) } : {}),
        ...(outcome.transcriptAt !== undefined ? { transcriptTo: outcome.transcriptAt } : {}),
      };
      if (!detachable || (outcome.ends !== undefined && shipsInlineFlag(argv))) {
        markWork(target);
        if (outcome.ends !== undefined) await shipInline(run, opts, appended);
      } else {
        const kicked: KickOutcome = kickHelper({ ...target, spawn: opts.helperSpawn, now });
        if (outcome.ends !== undefined && shipsInline(kicked)) await shipInline(run, opts, appended);
      }
    }

    const root = hold === null ? refreshableRoot(credential) : null;
    const notice = root === null ? null : deliveryNotice(readRegistryEntry(root, mycoHome) ?? credential, now());
    if (notice !== null) {
      process.stderr.write(`[myco] ${notice}\n`);
      if (outcome.notice) response = outcome.notice(notice, response);
    }
  } catch (error) {
    process.stderr.write(`[myco] ${hookName} error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, hookName, response);
  }
}

/** How often a hook waiting on another holder of the helper lock looks again. */
const INLINE_WAIT_MS = 100;

/**
 * Run the member helper's pass in this process, within what is left of the hook's budget, and start no helper after
 * it: what a hook does when no helper can outlive it. Its own session's capture is delivered before any context is
 * asked for. A helper already holding the lock (one started inside the harness's Job Object, say) is delivering the
 * same work: the hook waits on it until what this hook appended (`appended`) is delivered, or its budget is spent. A
 * helper clears its marks as a pass begins, not as it ends, so the marks say nothing of whether the work has reached
 * the Deployment; and the rest of the session (a subagent's transcript still growing) is not this hook's to wait on.
 */
async function shipInline(run: HookRun, opts: HookMainOptions, appended: HookAppended): Promise<void> {
  const { projectId } = run.credential;
  const entry = run.credential.source === 'registry' ? undefined : environmentEntry(run.credential, run.mycoHome);
  const pass = helperPass(projectId, run.mycoHome, { fetch: opts.fetch, now: run.now, entry, captureFirst: true });
  for (;;) {
    const left = run.budget.deadline - run.now();
    if (left <= 0) return;
    const result = await runHelper({ projectId, mycoHome: run.mycoHome, pass, now: run.now, deadlineMs: left, lingerMs: 0, noSuccessor: true });
    if (result.endedBy !== 'busy') return;
    if (hookDelivered(run.spool, run.sessionId, appended)) return;
    if (run.budget.deadline - run.now() <= INLINE_WAIT_MS) return;
    await new Promise((resolve) => setTimeout(resolve, INLINE_WAIT_MS));
  }
}

/** A credential from the environment, as the membership a pass delivers under: it rotates nothing and is held nowhere. */
function environmentEntry(credential: CredentialRecord, mycoHome: string): RegistryEntry {
  const at = Date.now();
  return {
    version: REGISTRY_VERSION, projectId: credential.projectId, serverUrl: credential.serverUrl, token: credential.token,
    tokenId: credential.tokenId, expiresAt: credential.expiresAt, root: credential.root ?? mycoHome, machineId: getMachineId(),
    joinedAt: at, updatedAt: at,
  };
}
