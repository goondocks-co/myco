import type { MycoIndex } from '../../index/sqlite.js';
import type { RouteResponse } from '../router.js';
import { SUMMARIZATION_FAILED_MARKER } from '../processor.js';

/** Serve session list from the SQLite index — no disk I/O required. */
export function handleGetSessions(index: MycoIndex): RouteResponse {
  const notes = index.query({ type: 'session' });

  const dateSet = new Set<string>();
  const sessions: Array<{ id: string; date: string; title: string; hasFailed: boolean }> = [];

  for (const note of notes) {
    // path is "sessions/YYYY-MM-DD/session-<id>.md"
    const parts = note.path.split('/');
    const date = parts[1] ?? '';
    const filename = parts[2] ?? '';
    const id = filename.replace('session-', '').replace('.md', '');

    dateSet.add(date);
    sessions.push({
      id,
      date,
      title: note.title || id.slice(0, 8),
      hasFailed: note.content.includes(SUMMARIZATION_FAILED_MARKER),
    });
  }

  const dates = [...dateSet].sort().reverse();
  return { body: { sessions, dates } };
}
