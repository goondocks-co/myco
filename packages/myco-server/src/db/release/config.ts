import type { RelationalStore } from '../../core/adapters.js';
import { commitNamed, first, read, write } from '../index.js';

/** A Project's release settings and last-check summary, as they are stored. */
export interface ReleaseConfigRow {
  revision: string;
  enabled: number;
  githubRepo: string | null;
  productionRefs: string;
  integrationRefs: string;
  packageMap: string;
  includeUnknown: number;
  maxLookups: number;
  secretSlot: string | null;
  updatedAt: number;
  updatedBy: string;
  checkRequestedAt: number | null;
  checkStartedAt: number | null;
  checkFinishedAt: number | null;
  checkStatus: 'complete' | 'partial' | 'unavailable' | null;
  checkFailure: string | null;
  checkCounts: string | null;
  checkLookups: number | null;
  lastCompleteAt: number | null;
}

const configRow = read<[project: string], ReleaseConfigRow>({ name: 'releaseConfig.row', sql:
  `SELECT revision,enabled,github_repo AS githubRepo,production_refs AS productionRefs,integration_refs AS integrationRefs,package_map AS packageMap,include_unknown AS includeUnknown,
     max_lookups AS maxLookups,secret_slot AS secretSlot,updated_at AS updatedAt,updated_by AS updatedBy,check_requested_at AS checkRequestedAt,check_started_at AS checkStartedAt,
     check_finished_at AS checkFinishedAt,check_status AS checkStatus,check_failure AS checkFailure,check_counts AS checkCounts,check_lookups AS checkLookups,last_complete_at AS lastCompleteAt
   FROM project_release_provenance WHERE project_id=?1` });

export const readReleaseConfig = (db: RelationalStore, project: string) => first(db, configRow.bind(project));

const unresolvedCount = read<[project: string, cap: number], { n: number }>({ name: 'releaseConfig.unresolvedCount', sql:
  'SELECT COUNT(*) AS n FROM (SELECT 1 FROM release_state_unresolved WHERE project_id=?1 LIMIT ?2)' });

/** How many stored release rows the namespace catch-up could not place, up to `cap`. */
export async function unresolvedReleaseStates(db: RelationalStore, project: string, cap: number): Promise<number> {
  return (await first(db, unresolvedCount.bind(project, cap)))?.n ?? 0;
}

/** Asks the next pass for a check when tracking is on: a held check keeps its lease and is checked again when it settles. */
const requestDue = write<[project: string], { requested: number }>({ name: 'releaseConfig.requestDue', sql:
  'UPDATE release_check_due SET next_at=CASE WHEN lease_id IS NULL THEN 0 ELSE next_at END WHERE project_id=?1 RETURNING 1 AS requested' });
const requestStamp = write<[project: string, now: number]>({ name: 'releaseConfig.requestStamp', sql:
  'UPDATE project_release_provenance SET check_requested_at=?2 WHERE project_id=?1 AND enabled=1 AND github_repo IS NOT NULL' });

export async function requestReleaseCheck(db: RelationalStore, project: string, now: number): Promise<boolean> {
  const { requested } = await commitNamed(db, { requested: requestDue.bind(project), stamped: requestStamp.bind(project, now) });
  return requested.results.length === 1;
}

