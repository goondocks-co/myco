/**
 * Plan list/get with the MCP response shape — the `PlanSummary` projection
 * (task-list progress fraction, tag splitting) is centralized here so every
 * caller produces the same wire shape without an HTTP round-trip.
 */

import {
  getPlan,
  listPlans,
  listPlansBySession,
  type PlanRow,
} from '@myco/db/queries/plans.js';
import { lookupLatestImportMappingBySource } from '@myco/db/queries/migration-import-journal.js';
import {
  projectScopeFromRequestContext,
  type MycoRequestContext,
} from '@myco/tools/request-context.js';
import { type ProjectScope, projectScope as toProjectScope } from '@myco/grove/ids.js';

export interface PlanSummary {
  id: string;
  title: string | null;
  status: string;
  progress: string;
  tags: string[];
  created_at: number;
}

export interface PlanSummaryWithContent extends PlanSummary {
  content: string | null;
}

function toPlanProgress(content: string | null): string {
  const planContent = content ?? '';
  const checked = (planContent.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (planContent.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  return total === 0 ? 'N/A' : `${checked}/${total}`;
}

function toPlanTags(tags: string | null): string[] {
  return tags ? tags.split(',').map((tag) => tag.trim()) : [];
}

function toPlanSummary(row: PlanRow): PlanSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    progress: toPlanProgress(row.content),
    tags: toPlanTags(row.tags),
    created_at: row.created_at,
  };
}

export interface ListPlansForMcpInput {
  id?: string;
  session?: string;
  status?: string;
  limit?: number;
  requestContext?: MycoRequestContext;
}

export type ListPlansForMcpResult =
  | { ok: true; plans: PlanSummary[] | PlanSummaryWithContent[] }
  | { ok: false; code: 'invalid-arguments'; message: string };

export function listPlansForMcp(input: ListPlansForMcpInput): ListPlansForMcpResult {
  const scope = projectScopeFromRequestContext(input.requestContext);

  if (input.id && input.session) {
    return {
      ok: false,
      code: 'invalid-arguments',
      message: 'Pass either id or session, not both',
    };
  }

  if (input.id) {
    const row = getPlan(input.id, scope)
      ?? getPlanByLegacyImportId(input.id, scope);
    if (!row) return { ok: true, plans: [] };
    return {
      ok: true,
      plans: [{ ...toPlanSummary(row), content: row.content }],
    };
  }

  if (input.session) {
    const rows = listPlansBySession(input.session, scope);
    return { ok: true, plans: rows.map(toPlanSummary) };
  }

  const statusFilter = input.status === 'all' ? undefined : input.status;
  const rows = listPlans({ scope, status: statusFilter, limit: input.limit });
  return { ok: true, plans: rows.map(toPlanSummary) };
}

function getPlanByLegacyImportId(id: string, scope: ProjectScope): PlanRow | null {
  if (scope.kind !== 'project') return null;
  const mapping = lookupLatestImportMappingBySource('plans', id, {
    target_table: 'plans',
    target_project_id: scope.id,
  });
  if (!mapping || mapping.status !== 'imported') return null;
  return getPlan(mapping.target_id, scope);
}
