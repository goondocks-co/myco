/**
 * The recall surface: what a member's prompt hook is served for one prompt.
 *
 * The route answers within the hook's own budget, so it composes and answers in
 * one call and holds no state of its own beyond the records `core/recall.ts`
 * writes. `skipped` names every contributor that served nothing, so a caller
 * reads an empty block as a decision rather than a silence.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { composePromptContext, readRecallLeaves } from '../core/recall.js';
import { settingsWriter } from '../core/settings.js';
import { MAX_BODY_BYTES } from '../ingest/body.js';
import { refusal } from '../telemetry.js';
import { refused } from '../ingest/events.js';

const MAX_SESSION_CHARS = 384;
const MAX_PROMPT_ID_CHARS = 192;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

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
  const text = str(body.text, MAX_BODY_BYTES);
  if (sessionId === null || promptId === null || text === null) {
    return Response.json(refused(ctx, refusal('prompt context requires sessionId, promptId and text', 'parse')));
  }

  const [leaves, capabilityOn] = await Promise.all([
    readRecallLeaves(env.db),
    settingsWriter(env.db).capabilityEnabled(ctx.projectId, 'cortex'),
  ]);
  const served = await composePromptContext(env.db, { projectId: ctx.projectId }, leaves, capabilityOn, {
    sessionId, promptId, text, now: ctx.now,
  });
  return Response.json({ persisted: true, ...served });
}
