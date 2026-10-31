/**
 * A turn as the card rules read it, built from the records of its own pages. The publisher builds it from the pages it
 * writes; card settlement and the card and learning runs build it from the live document.
 */
import type { ContentStore } from '../core/adapters.js';
import type { TurnInput } from '../core/turn-card-rules.js';
import type { DocRecord } from './document.js';
import { SessionDocument, TURN_PAGES } from './session-pages.js';

/** The canonical plan a plan appearance belongs to. */
const planKeyOf = (record: DocRecord): string => (typeof record.plan_key === 'string' ? record.plan_key : record.id);

/** The turn a document's records describe; a plan appears as its latest appearance. */
export function turnInput(turnKey: string, records: readonly DocRecord[]): TurnInput | null {
  const prompt = records.find((record) => record.k === 'prompt' && record.id === turnKey);
  if (prompt === undefined) return null;
  const s = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    turnKey, origin: s(prompt.origin) || 'user', prompt: s(prompt.text),
    steering: records.filter((r) => r.k === 'prompt' && r.id !== turnKey).map((r) => ({ promptId: r.id, text: s(r.text) })),
    replies: records.filter((r) => r.k === 'reply').map((r) => ({ responseId: r.id, text: s(r.text) })),
    tools: records.filter((r) => r.k === 'tool').map((r) => ({
      toolCallId: r.id, toolName: s(r.tool_name), input: typeof r.input === 'string' ? r.input : null,
      output: typeof r.output_preview === 'string' ? r.output_preview : null, success: r.success === 1,
      errorMessage: typeof r.error_message === 'string' ? r.error_message : null,
    })),
    plans: [...new Map(records.filter((r) => r.k === 'plan').map((r) => [planKeyOf(r), r])).values()].map((r) => ({
      planKey: planKeyOf(r), title: typeof r.title === 'string' ? r.title : null, status: s(r.status), content: typeof r.content === 'string' ? r.content : null,
    })),
  };
}

/**
 * A turn of the session's live document, read from at most `TURN_PAGES` of its pages; null when the session has no
 * live document or the document holds no such turn. A caller reading several turns of one session passes its document.
 */
export async function documentTurnInput(env: ContentStore, projectId: string, sessionId: string, turnKey: string,
  document?: SessionDocument | null): Promise<TurnInput | null> {
  const doc = document === undefined ? await SessionDocument.open(env, projectId, sessionId) : document;
  if (doc === null) return null;
  const { pages } = await doc.ownerPages(turnKey, 0, TURN_PAGES);
  return turnInput(turnKey, pages.flatMap((page) => page.records));
}
