/**
 * myco_plans — list active implementation plans and their status.
 *
 * Delegates to PGlite `listPlans()` and `getPlan()` query helpers.
 */

import { listPlans, getPlan, type PlanRow } from '@myco/db/queries/plans.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlansInput {
  status?: string;
  limit?: number;
}

interface PlanSummary {
  id: string;
  title: string | null;
  status: string;
  progress: string;
  tags: string[];
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract checklist progress from plan content. */
function extractProgress(content: string | null): string {
  if (!content) return 'N/A';
  const checked = (content.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (content.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  if (total === 0) return 'N/A';
  return `${checked}/${total}`;
}

function toSummary(row: PlanRow): PlanSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    progress: extractProgress(row.content),
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()) : [],
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoPlans(
  input: PlansInput,
): Promise<PlanSummary[]> {
  const statusFilter = input.status === 'all' ? undefined : input.status;

  const rows = await listPlans({
    status: statusFilter,
    limit: input.limit,
  });

  return rows.map(toSummary);
}
