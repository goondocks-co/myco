import { uuidv5 } from '../hash.js';
import type { RelationalStore } from '../core/adapters.js';
import { TRANSCRIPT_PARSE_ADAPTER } from '../constants.js';
import { type DerivedEvent, type ParserState } from './parsers/index.js';

/** A reread bounds both legacy reply lookups and checkpoint replay by source records. */
export const LEGACY_REPLY_LINES_PER_READ = 1000;
const LEGACY_REPLY_LOOKUP_IDS = LEGACY_REPLY_LINES_PER_READ;

/** Existing joined replies retain their captured coverage across rereads. */
export async function legacyReplies(db: RelationalStore, projectId: string, transcriptId: string, events: readonly DerivedEvent[], state: ParserState, called: () => void): Promise<Map<string, string>> {
  const ids = await Promise.all(events.filter((event) => event.kind === 'response' && event.offset < (state.legacyReplies?.until ?? 0))
    .map((event) => uuidv5('transcript-event', transcriptId, event.kind, String(event.payload.responseId))));
  const held = new Map<string, string>();
  for (let at = 0; at < ids.length; at += LEGACY_REPLY_LOOKUP_IDS) {
    const { results } = await db.prepare(`SELECT r.response_id, r.text FROM responses r JOIN events e ON e.project_id = r.project_id AND e.event_id = r.event_id
      WHERE r.project_id = ? AND e.producer_adapter = ? AND e.event_id IN (SELECT value FROM json_each(?))`)
      .bind(projectId, TRANSCRIPT_PARSE_ADAPTER, JSON.stringify(ids.slice(at, at + LEGACY_REPLY_LOOKUP_IDS))).all<{ response_id: string; text: string | null }>();
    called();
    for (const row of results) if (row.text !== null) held.set(row.response_id, row.text);
  }
  return held;
}

/** Only an exact ordered text prefix under the same first-record identity supplies coverage. */
export function preserveLegacyReplies(events: readonly DerivedEvent[], state: ParserState, held: ReadonlyMap<string, string>): DerivedEvent[] {
  return events.filter((event) => {
    const legacy = state.legacyReplies;
    if (legacy === undefined || event.kind !== 'response') return true;
    if (event.offset >= legacy.until) { delete state.legacyReplies; return true; }
    const text = event.payload.text;
    if (typeof text !== 'string') return true;
    const consume = (remaining: string): boolean => {
      const normalized = remaining.trimStart();
      if (normalized.trimEnd() === text) { delete legacy.remaining; return true; }
      if (!normalized.startsWith(text)) return false;
      const suffix = normalized.slice(text.length);
      const boundary = /^\s*?\n\n/.exec(suffix);
      if (boundary === null) return false;
      legacy.remaining = suffix.slice(boundary[0].length);
      return true;
    };
    if (legacy.remaining !== undefined && legacy.promptId === event.payload.promptId && consume(legacy.remaining)) return false;
    delete legacy.remaining;
    const old = held.get(String(event.payload.responseId));
    if (old !== undefined && old !== text && consume(old)) {
      legacy.promptId = typeof event.payload.promptId === 'string' ? event.payload.promptId : undefined;
      return false;
    }
    return true;
  });
}
