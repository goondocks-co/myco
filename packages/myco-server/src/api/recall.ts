/**
 * The recall surface: what a member's hooks are served for one prompt, and for
 * one session or subagent start.
 *
 * The route answers within the hook's own budget, so it composes and answers in
 * one call and holds no state of its own beyond the records `core/recall.ts`
 * writes. `skipped` names, for every contributor that served nothing, the gate
 * it closed on — or the contributor alone when it failed — so a caller reads an
 * empty block as a named decision rather than a silence.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { composePromptContext, composeSessionContext, readRecallLeaves } from '../core/recall.js';
import { parseSessionContextIdentity } from '@goondocks/myco-shared/recall';
import { resolveSemanticSearch } from '../core/search.js';
import { settingsWriter } from '../core/settings.js';
import { refusal } from '../telemetry.js';
import { refused } from '../ingest/events.js';

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

export async function handlePromptContext(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));

  const sessionId = str(body.sessionId, MAX_SESSION_CHARS);
  const promptId = str(body.promptId, MAX_PROMPT_ID_CHARS);
  const text = promptText(body.text);
  if (sessionId === null || promptId === null || text === null) {
    return Response.json(refused(ctx, refusal('prompt context requires sessionId, promptId and text', 'parse')));
  }

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

  const sessionId = str(body.sessionId, MAX_SESSION_CHARS);
  const identity = parseSessionContextIdentity(body);
  if (sessionId === null || identity === null) {
    const reason = body.kind === 'compact'
      ? 'compact context requires sessionId and a positive safe-integer compaction ordinal'
      : 'session context requires sessionId and kind "start" or "subagent"';
    return Response.json(refused(ctx, refusal(reason, 'parse')));
  }

  const [leaves, capabilityOn] = await Promise.all([
    readRecallLeaves(env.db),
    settingsWriter(env.db).capabilityEnabled(ctx.projectId, 'cortex'),
  ]);
  const served = await composeSessionContext(env.db, { projectId: ctx.projectId }, leaves, capabilityOn, {
    sessionId, ...identity, now: ctx.now,
  });
  return Response.json({ persisted: true, ...served });
}
