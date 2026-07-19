import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { isAttachedTenancyPending, resolveAttachedEmpty } from '../lib/degrade';
import { useProjectSelection } from './use-project-selection';

export interface TableBreakdownRow {
  name: string;
  rows: number;
  index_count: number;
  is_fts: boolean;
}

export interface IndexInfo {
  name: string;
  table: string;
  type: 'btree' | 'auto';
  sql: string | null;
}

export interface DatabaseDetails {
  file: {
    path: string;
    size_bytes: number;
    wal_size_bytes: number;
    page_size: number;
    page_count: number;
    freelist_count: number;
    fragmentation_pct: number;
  };
  schema: {
    version: number;
    journal_mode: string;
    foreign_keys: boolean;
  };
  tables: TableBreakdownRow[];
  indexes: IndexInfo[];
  last_optimize_at: string | null;
  last_vacuum_at: string | null;
  last_integrity_check: { at: string; status: 'ok' | 'issues' } | null;
}

/**
 * The zero-state an attached project shows before its first forwarded capture
 * registers it host-side — the BEHAVE-LIKE-LOCAL twin of a fresh local project's
 * `/database/details`. `GET /api/database/details` is serve-stamped, so it 404s
 * `unknown_tenancy` for an attached pre-first-capture project; mapping that to
 * this empty shape keeps the Database tab on its normal body instead of a raw
 * "Error: unknown_tenancy" message + a retry/poll storm.
 */
const EMPTY_DATABASE_DETAILS: DatabaseDetails = {
  file: {
    path: '',
    size_bytes: 0,
    wal_size_bytes: 0,
    page_size: 0,
    page_count: 0,
    freelist_count: 0,
    fragmentation_pct: 0,
  },
  schema: { version: 0, journal_mode: '', foreign_keys: false },
  tables: [],
  indexes: [],
  last_optimize_at: null,
  last_vacuum_at: null,
  last_integrity_check: null,
};

export function useDatabaseDetails() {
  const selection = useProjectSelection();
  return resolveAttachedEmpty(
    usePowerQuery<DatabaseDetails>({
      queryKey: ['database-details'],
      queryFn: ({ signal }) => fetchJson<DatabaseDetails>('/database/details', { signal }),
      refetchInterval: (query) =>
        isAttachedTenancyPending(query.state.error, selection) ? false : POLL_INTERVALS.STATS,
      retry: (failureCount, err) =>
        isAttachedTenancyPending(err, selection) ? false : failureCount < 3,
      pollCategory: 'standard',
    }),
    selection,
    EMPTY_DATABASE_DETAILS,
  );
}
