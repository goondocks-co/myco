import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { latestLiveCapture } from '../capture/live.js';

const revisions = read<[], { kind: string; revision: number }>({ name: 'meta.changeMarks', sql: 'SELECT kind,revision FROM change_marks' });

export async function todayMarks(db: RelationalStore): Promise<string[]> {
  const [marks, sessions] = await readSet(db, revisions.bind(), latestLiveCapture());
  const byKind = new Map(marks.map(row => [row.kind, String(row.revision)]));
  return [byKind.get('runs')!, `${sessions[0]?.at ?? ''}|${byKind.get('sessions')!}`, byKind.get('curation')!, byKind.get('plans')!, byKind.get('attention') ?? '', byKind.get('learning') ?? ''];
}
