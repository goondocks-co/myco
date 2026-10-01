/**
 * The recall surface: what a member's hooks are served for one prompt, and for
 * one session or subagent start.
 *
 * A session start may name the repository's git remote. Binding it here costs
 * one idempotent write on a call the member already makes, and it is what lets
 * a later tool call name this Project by its remote rather than by an id the
 * agent has no way to know.
 *
 * The route answers within the hook's own budget, so it composes and answers in
 * one call and holds no state of its own beyond the records `core/recall.ts`
 * writes. `skipped` names, for every contributor that served nothing, the gate
 * it closed on — or the contributor alone when it failed — so a caller reads an
 * empty block as a named decision rather than a silence.
 */
import { machineBlockFor } from '../core/machine-settings.js';
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { composePromptContext, composeSessionContext, readRecallLeaves } from '../core/recall.js';
import { parseSessionContextIdentity } from '@goondocks/myco-shared/recall';
import { resolveSemanticSearch } from '../core/search.js';
import { settingsWriter } from '../core/settings.js';
import { classify, emit, refusal } from '../telemetry.js';
import { startTurnStatement, turnStartedAt } from '../ingest/turns.js';
import { refused } from '../ingest/events.js';
import { MAX_REMOTE_CHARS, normalizeRemote, recordProjectRemote } from '../core/remotes.js';

const MAX_SESSION_CHARS = 384;
const MAX_PROMPT_ID_CHARS = 192;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
/** The prompt text, bounded already: the pipeline caps the whole body in bytes before this handler runs. */
const promptText = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const BAD_BODY = refusal('body is not an object', 'parse');

/**
 * Open the session's turn, past the answer: the prompt asking for context is the turn's start, and the answer never
 * waits on the write. It is registered before anything is composed, so a compose that is slow, fails, or is cut off
 * by a client that stopped waiting still leaves the turn open: the deferral outlives the request on both targets.
 * Nothing the answer does waits on it: on the hosted target the write runs beside the compose, and on the
 * self-hosted target, where deferred work starts at once, it is one keyed UPDATE ahead of the compose's reads. A
 * write that fails, or cannot be deferred, is reported and leaves the answer as it is; the session then reads as
 * working only while its receipts are recent.
 */
export function noteTurnStarted(env: ServerEnv, ctx: RouteContext, sessionId: string, promptId: string): void {
  const unrecorded = (err: unknown) => emit({ kind: 'turn_start_unrecorded', projectId: ctx.projectId, tokenId: ctx.tokenId, error: classify(err) });
  try {
    env.afterResponse(async () => {
      try {
        const at = turnStartedAt(promptId, ctx.now);
        if (at !== null) await startTurnStatement(env.db, { projectId: ctx.projectId, sessionId, machineId: ctx.machineId, at }).run();
      } catch (err) {
        unrecorded(err);
      }
    });
  } catch (err) {
    unrecorded(err);
  }
}

export async function handlePromptContext(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));

  const sessionId = str(body.sessionId, MAX_SESSION_CHARS);
  const promptId = str(body.promptId, MAX_PROMPT_ID_CHARS);
  const text = promptText(body.text);
  if (sessionId === null || promptId === null || text === null) {
    return Response.json(refused(ctx, refusal('prompt context requires sessionId, promptId and text', 'parse')));
  }

  // Registered first and never awaited: the turn opens whatever becomes of the compose below.
  noteTurnStarted(env, ctx, sessionId, promptId);
  const [leaves, capabilityOn] = await Promise.all([
    readRecallLeaves(env.db),
    settingsWriter(env.db).capabilityEnabled(ctx.projectId, 'cortex'),
  ]);
  const served = await composePromptContext(env.db, { projectId: ctx.projectId }, leaves, capabilityOn, {
    sessionId, promptId, text, now: ctx.now,
  }, () => resolveSemanticSearch(env));
  return Response.json({ persisted: true, ...served });
}

export async function handleSessionContext(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));

  // A preview names no session: the block is composed for a member about to have sessions, and nothing is recorded.
  const preview = body.preview === true;
  const sessionId = preview ? null : str(body.sessionId, MAX_SESSION_CHARS);
  const identity = parseSessionContextIdentity(body);
  if ((sessionId === null && !preview) || (preview && body.sessionId !== undefined) || identity === null) {
    const reason = preview
      ? 'a session context preview names no sessionId, and kind "start" or "subagent"'
      : body.kind === 'compact'
        ? 'compact context requires sessionId and a positive safe-integer compaction ordinal'
        : 'session context requires sessionId and kind "start" or "subagent"';
    return Response.json(refused(ctx, refusal(reason, 'parse')));
  }

  // A session start is where a member first names its repository, and the
  // binding is what lets a later tool call address this Project by remote.
  //
  // A remote past the bound is a fault of the caller's own making and is
  // refused. A remote this Deployment cannot normalize is DROPPED:
  // the member sends whatever `git remote get-url origin` prints, and a
  // checkout whose origin is a filesystem path is an ordinary clone rather than
  // a malformed request. Refusing it would cost that repository its whole
  // session block — the Project line, the instructions, everything — on every
  // session, to bind a name no caller looks up.
  const named = body.remote;
  if (named !== undefined) {
    if (typeof named !== 'string' || named.length > MAX_REMOTE_CHARS) {
      return Response.json(refused(ctx, refusal(`remote must be a string of at most ${MAX_REMOTE_CHARS} characters`, 'parse')));
    }
    const remote = normalizeRemote(named);
    if (remote !== null) await recordProjectRemote(env.db, ctx.projectId, remote, ctx.now);
  }

  const [leaves, capabilityOn] = await Promise.all([
    readRecallLeaves(env.db),
    settingsWriter(env.db).capabilityEnabled(ctx.projectId, 'cortex'),
  ]);
  const [served, machine] = await Promise.all([
    composeSessionContext(env.db, { projectId: ctx.projectId }, leaves, capabilityOn, { sessionId: sessionId ?? '', ...identity, now: ctx.now }, { preview }),
    // The machine's own settings, where the member asking claims it; a machine keeps them from its session start.
    machineBlockFor(env.db, ctx.memberId, ctx.machineId),
  ]);
  return Response.json({ persisted: true, ...served, ...(machine === null ? {} : { machine }) });
}
