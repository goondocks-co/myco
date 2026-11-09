import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { projectionPhases, publicationReady } from '../projections/catchup.js';
import { DEPENDENCY_PROJECTION, DEPENDENCY_STATUS } from './dependencies.js';
import { LIFECYCLE_PROJECTION } from './lifecycle.js';

export interface DocumentStatus {
  sessions: { live: number; converting: number };
  lagBytes: number;
  queued: number;
  retired: number;
  differences: Record<string, number>;
  /** Queued events waiting on a prerequisite: their cycle inspections pending and cycles found, or building while held causes are translated. */
  dependencies: { waiting: number; inspecting: number; cycles: number } | { state: 'building' };
  /** Whether every session's lifecycle facts are built from its history. */
  lifecycle: 'ready' | 'building';
}
interface Totals { live: number; converting: number; lag: number; queued: number; retired: number }
const totals = read<[], Totals>({ name: 'publication.statusTotals', sql: 'SELECT live,converting,lag,queued,retired FROM document_status_totals WHERE slot=1' });
const differences = read<[], { class: string; n: number }>({ name: 'publication.statusDifferences', sql: 'SELECT class,n FROM document_difference_totals' });

/** Unfinished contribution initialization has no published numerical status. */
export async function readDocumentStatus(db: RelationalStore): Promise<DocumentStatus | { state: 'building' }> {
  const [phases, rows, classes] = await readSet(db, projectionPhases.bind('publication'), totals.bind(), differences.bind());
  if (!publicationReady(phases)) return { state: 'building' };
  const row = rows[0]!;
  const [dependencyPhases, dependency, lifecyclePhases] = await readSet(db, projectionPhases.bind(DEPENDENCY_PROJECTION), DEPENDENCY_STATUS.bind(), projectionPhases.bind(LIFECYCLE_PROJECTION));
  const dependencies = dependencyPhases.every(item => item.done === 1) && dependency[0] !== undefined ? dependency[0] : { state: 'building' as const };
  return { sessions: { live: row.live, converting: row.converting }, lagBytes: row.lag, queued: row.queued, retired: row.retired,
    differences: Object.fromEntries(classes.map(item => [item.class, item.n])), dependencies,
    lifecycle: lifecyclePhases.length > 0 && lifecyclePhases.every(item => item.done === 1) ? 'ready' : 'building' };
}

interface DueBacklog {
  sessions: number;
  /** True when a due class extends past the observed page; counts are lower bounds. */
  limited?: true;
}
interface ReadyMeasures {
  state?: 'ready';
  transcripts: number;
  bytes: number;
  imported: { sessions: number; transcripts: number; bytes: number };
}
interface BuildingMeasures {
  state: 'building';
  transcripts: null;
  bytes: null;
  imported: { sessions: null; transcripts: null; bytes: null };
}
export type PublicationBacklog = DueBacklog & (ReadyMeasures | BuildingMeasures);
/** Due sessions observed per capture class; both classes remain visible to wake admission. */
export const PUBLICATION_BACKLOG_PAGE = 64;
const due = read<[number, number, number], { transcripts: number; bytes: number }>({ name: 'publication.backlog', sql: `SELECT f.transcripts,f.bytes FROM document_due q CROSS JOIN document_publication_facts f
  WHERE q.imported=? AND q.due_at<=? AND f.project_id=q.project_id AND f.session_id=q.session_id
  ORDER BY q.due_at,q.project_id,q.session_id LIMIT ?` });

/** Due membership stays live while contribution measures are building. */
export async function pendingPublication(db: RelationalStore, now: number): Promise<PublicationBacklog> {
  const [phases, ...rows] = await readSet(db, projectionPhases.bind('publication'),
    due.bind(0, now, PUBLICATION_BACKLOG_PAGE + 1), due.bind(1, now, PUBLICATION_BACKLOG_PAGE + 1));
  const pages = rows.map(items => items.slice(0, PUBLICATION_BACKLOG_PAGE));
  const membership = { sessions: pages.reduce((n, page) => n + page.length, 0),
    ...(rows.some(items => items.length > PUBLICATION_BACKLOG_PAGE) ? { limited: true as const } : {}) };
  if (!publicationReady(phases)) return { ...membership, state: 'building', transcripts: null, bytes: null,
    imported: { sessions: null, transcripts: null, bytes: null } };
  const counts = pages.map(page => ({ sessions: page.length,
    transcripts: page.reduce((n, row) => n + row.transcripts, 0), bytes: page.reduce((n, row) => n + row.bytes, 0) }));
  return { ...membership, transcripts: counts[0]!.transcripts + counts[1]!.transcripts,
    bytes: counts[0]!.bytes + counts[1]!.bytes, imported: counts[1]! };
}
