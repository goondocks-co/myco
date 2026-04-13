import type { TableBreakdownRow, IndexInfo } from '@myco/db/queries/database.js';

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

export interface OptimizeAction {
  name: string;
  duration_ms: number;
  ok: boolean;
  error?: string;
}

export interface OptimizeResult {
  actions_completed: OptimizeAction[];
  actions_failed: OptimizeAction[];
  duration_ms: number;
}

export interface VacuumResult {
  size_before: number;
  size_after: number;
  freed_bytes: number;
  duration_ms: number;
}

export interface ReindexResult {
  duration_ms: number;
}

export interface IntegrityResult {
  status: 'ok' | 'issues';
  issues: string[];
  fk_violations: number;
  duration_ms: number;
}

/** Error-code discriminant returned by the vacuum HTTP handler on 409. */
export const VACUUM_ERROR_CODE = 'insufficient_disk_space' as const;

export class VacuumPrecheckError extends Error {
  constructor(public required_bytes: number, public free_bytes: number) {
    super('VACUUM requires at least ' + required_bytes + ' bytes free; only ' + free_bytes + ' available');
    this.name = 'VacuumPrecheckError';
  }
}
