/**
 * The one capture path every hook runs: read the normalized input, resolve
 * the declared credential, build the envelope(s), append them to the session
 * spool FIRST, drain under the hook's own budget, then write the hook
 * response. A hook's `main()` is a thin call into `runMemberHook`.
 */
import { readHookInput } from '../hooks/input.js';
import type { NormalizedHookInput } from '../hooks/normalize.js';
import { writeHookResponse, type HookResponse } from '../hooks/response.js';
import { resolveHookBudget, type HookBudget } from './budget.js';
import { parseCredentialFlag, resolveCredential, type CredentialRecord, type CredentialSource } from './credential.js';
import type { EnvelopeContext, OutboundEvent } from './envelope.js';
import { MemberSpool } from './spool.js';
import { ServerClient, type FetchLike } from './transport.js';

export interface HookMainOptions {
  /** The declared credential source; read from `--credential` on argv when absent. */
  credential?: CredentialSource | null;
  fetch?: FetchLike;
  argv?: readonly string[];
  now?: () => number;
  /** When the hook's budget clock started; defaults to this process's start. */
  startedAt?: number;
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
  response?: HookResponse;
  /** Dial even while the offline latch is set (Stop/SessionEnd always probe). */
  probe?: boolean;
  /** Work after the spool drain, inside the budget (transcript shipping). */
  afterDrain?: (run: HookRun) => Promise<void>;
}

/** The harness event name the input carries, when the harness sends one (`hook_event_name`). */
const harnessEventOf = (input: NormalizedHookInput): string | undefined =>
  typeof input.raw.hook_event_name === 'string' ? input.raw.hook_event_name : undefined;

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
    const credential = resolveCredential(source);
    if (!credential) return;

    const now = opts.now ?? Date.now;
    const budget = resolveHookBudget(input.agent, hookName, { hookEventName: harnessEventOf(input), startedAt: opts.startedAt });
    const spool = new MemberSpool(credential.projectId);
    const ctx: EnvelopeContext = { agent: input.agent, sessionId, stage: spool.stage, now };
    const client = new ServerClient(credential, opts.fetch ?? globalThis.fetch);
    const run: HookRun = { hookName, input, sessionId, agent: input.agent, credential, spool, ctx, budget, client, now, argv };

    const outcome = await handle(run);
    response = outcome.response ?? {};
    for (const event of outcome.events) spool.append(sessionId, event);
    if (budget.drains) {
      await spool.drainSession(sessionId, client, budget, { force: outcome.probe, now });
      if (outcome.afterDrain) await outcome.afterDrain(run);
    }
  } catch (error) {
    process.stderr.write(`[myco] ${hookName} error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, hookName, response);
  }
}
