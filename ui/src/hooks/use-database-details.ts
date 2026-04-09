import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

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

export function useDatabaseDetails() {
  return usePowerQuery<DatabaseDetails>({
    queryKey: ['database-details'],
    queryFn: ({ signal }) => fetchJson<DatabaseDetails>('/database/details', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
