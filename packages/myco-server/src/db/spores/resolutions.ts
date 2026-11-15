import type { RelationalStore } from '../../core/adapters.js';
import type { ReadScope } from '../../read/scope.js';
import { first, read } from '../index.js';
import { authorKindSql } from './browse.js';

/** A spore's newest lifecycle event: what moved it, who did, when, why when they said, and what took its place when something did. */
export interface SporeResolution {
  action: string;
  author: string | null;
  authorKind: 'run' | 'member' | 'imported' | 'grant' | null;
  reason: string | null;
  newSporeId: string | null;
  createdAt: number;
}

const latest = read<[project: string, spore: string], SporeResolution>({
  name: 'sporeResolutions.latest',
  sql: `SELECT e.action, e.author, ${authorKindSql('e')} AS authorKind, e.reason, e.new_spore_id AS newSporeId, e.created_at AS createdAt
    FROM resolution_events e WHERE e.project_id=?1 AND e.spore_id=?2 ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
});

/** The newest lifecycle event a spore holds, events at the same instant ordered as they were committed; null for one that never moved. */
export const latestSporeResolution = (db: RelationalStore, scope: ReadScope, sporeId: string): Promise<SporeResolution | null> =>
  first(db, latest.bind(scope.projectId, sporeId));
