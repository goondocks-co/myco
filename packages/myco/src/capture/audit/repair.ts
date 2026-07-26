import fs from 'node:fs';

import { openDatabase } from '../../db/client.js';

/**
 * Repair for audit findings.
 *
 * Separate from the audit, which is read-only. Dry-run is the default and
 * `apply` must be passed explicitly; a `.bak` of the vault is taken before the
 * first write.
 *
 * Deliberately narrow. Data preservation is Myco's core contract, so a repair
 * that loses data is worse than the finding it fixes. Permitted operations
 * only recompute values that are derivable from rows already present. Never
 * permitted, under any circumstance: DELETE, rewriting `user_prompt` or any
 * captured content, changing ids or foreign keys.
 */

export interface RepairOptions {
  dbPath: string;
  findingId: string;
  projectId?: string;
  /** Without this nothing is written, regardless of any other flag. */
  apply?: boolean;
  /** Above this many rows the caller must confirm again before applying. */
  confirmThreshold?: number;
}

export interface RepairPlan {
  findingId: string;
  supported: boolean;
  /** Human-readable description of each row that would change. */
  changes: string[];
  rowCount: number;
  applied: boolean;
  backupPath?: string;
  /** Set when the repair is refused; explains why. */
  refusal?: string;
  requiresConfirmation: boolean;
}

const DEFAULT_CONFIRM_THRESHOLD = 100;

/**
 * Findings this tool will not repair, and why.
 *
 * Listed explicitly rather than silently unsupported: an audit that reports a
 * finding and a repair tool that quietly ignores it reads as "nothing to do".
 */
const REFUSALS: Record<string, string> = {
  'batch-null-content-hash':
    "Not repairable here. promptBatchContentHash needs an `ordinal` — the occurrence index of a matching (origin, text) pair within the session — and batches.ts states the live-path ordinal is 'not valid for backfill / out-of-order callers'. A backfill must reconstruct the miner's positional ordinal exactly; a mismatch writes a wrong dedup key, which is worse than a NULL one because it silently blocks or forces a future match. Needs its own change with the miner's derivation reused directly.",
  'batch-missing-response':
    'Not repairable here. The response text lives in the transcript, so recovering it is a re-mine of the owning session rather than a column update. Use the mining path, which also updates activities and counters consistently.',
  'transcript-never-captured':
    'Not repairable here. These sessions were never ingested at all, so there is no row to fix — they need a backfill mine of the transcripts on disk.',
  'envelope-classified-human':
    'Not repairable here without deciding the correct origin per tag, which is a judgment call and belongs in a manifest rule. Fix the classification first so new rows land correctly, then reclassify the backlog deliberately.',
  'batch-orphaned':
    'Refused by design. These batches hold captured user work whose session row is missing; the only mechanical "fix" would be deletion, which is forbidden. Re-parent deliberately or escalate.',
};

/** Recompute denormalised session counters from the rows they summarise. */
function planCounterRecompute(
  db: ReturnType<typeof openDatabase>,
  projectId?: string,
): Array<{ id: string; from: number; to: number }> {
  const scope = projectId ? ' AND s.project_id = $projectId' : '';
  const params = projectId ? { $projectId: projectId } : {};
  return db
    .query(
      `SELECT s.id id, s.prompt_count AS "from",
              (SELECT COUNT(*) FROM prompt_batches pb WHERE pb.session_id = s.id) AS "to"
         FROM sessions s
        WHERE s.prompt_count != (SELECT COUNT(*) FROM prompt_batches pb WHERE pb.session_id = s.id)${scope}`,
    )
    .all(params) as Array<{ id: string; from: number; to: number }>;
}

export function repair(opts: RepairOptions): RepairPlan {
  const refusal = REFUSALS[opts.findingId];
  if (refusal) {
    return {
      findingId: opts.findingId,
      supported: false,
      changes: [],
      rowCount: 0,
      applied: false,
      refusal,
      requiresConfirmation: false,
    };
  }

  if (opts.findingId !== 'session-counter-drift') {
    return {
      findingId: opts.findingId,
      supported: false,
      changes: [],
      rowCount: 0,
      applied: false,
      refusal: `Unknown finding id "${opts.findingId}". Repairable ids: session-counter-drift.`,
      requiresConfirmation: false,
    };
  }

  const db = openDatabase(opts.dbPath);
  try {
    const rows = planCounterRecompute(db, opts.projectId);
    const threshold = opts.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD;
    const plan: RepairPlan = {
      findingId: opts.findingId,
      supported: true,
      changes: rows.map((r) => `${r.id}: prompt_count ${r.from} → ${r.to}`),
      rowCount: rows.length,
      applied: false,
      requiresConfirmation: rows.length > threshold,
    };

    if (!opts.apply || rows.length === 0) return plan;

    const backupPath = `${opts.dbPath}.bak`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(opts.dbPath, backupPath);
    plan.backupPath = backupPath;

    const update = db.query(`UPDATE sessions SET prompt_count = $to WHERE id = $id`);
    db.transaction(() => {
      for (const row of rows) update.run({ $to: row.to, $id: row.id });
    })();

    plan.applied = true;
    return plan;
  } finally {
    db.close();
  }
}
