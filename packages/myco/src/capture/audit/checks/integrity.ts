import type { Database } from 'bun:sqlite';

import { aggregate, findingFrom, scopeClause } from '../context.js';
import type { AuditOptions, Finding } from '../types.js';

/**
 * Vault-only invariants. Needs no transcripts, so it runs for every symbiont
 * under either capture model and is the cheapest useful signal.
 */
export function checkIntegrity(db: Database, opts: AuditOptions, now: number): Finding[] {
  const findings: Finding[] = [];
  const batch = scopeClause('b', opts.projectId, opts.since);
  const session = scopeClause('s', opts.projectId, opts.since);

  const add = (
    base: Parameters<typeof findingFrom>[0],
    sql: string,
    params: Record<string, string | number>,
  ) => {
    const row = aggregate(db, sql, params);
    if (row && row.n > 0) findings.push(findingFrom(base, row, now));
  };

  // A NULL content_hash defeats dedup, so reconciliation can re-insert the
  // same prompt as a fresh batch — the documented duplicate-prompt cause.
  add(
    {
      id: 'batch-null-content-hash',
      layer: 'integrity',
      severity: 'high',
      title: 'Prompt batches with NULL content_hash',
      detail:
        'content_hash is the dedup key. NULL rows cannot be matched, so a later reconciliation pass can insert a duplicate of the same prompt.',
    },
    `SELECT COUNT(*) n, MIN(b.created_at) first_seen, MAX(b.created_at) last_seen,
            GROUP_CONCAT(b.id) samples
     FROM prompt_batches b WHERE b.content_hash IS NULL${batch.sql}`,
    batch.params,
  );

  // Empty response_summary means the assistant side of the turn never landed.
  // Scoped to human-origin batches. A runtime-injected envelope does not form
  // a conversational turn, so it usually carries no assistant response —
  // three quarters of system-origin batches have none, against roughly seven
  // percent of human ones. Counting them together buries the real signal under
  // by-design behavior that grows with every injected notification.
  add(
    {
      id: 'batch-missing-response',
      layer: 'pipeline',
      severity: 'medium',
      title: 'Human prompt batches with no response_summary',
      detail:
        'A person typed a prompt and the assistant response was never attached. Points at a Stop hook that did not fire or a mine that did not run. Non-human origins are excluded: an injected envelope having no response is normal.',
    },
    `SELECT COUNT(*) n, MIN(b.created_at) first_seen, MAX(b.created_at) last_seen,
            GROUP_CONCAT(b.id) samples
     FROM prompt_batches b
     WHERE (b.response_summary IS NULL OR b.response_summary = '')
       AND b.status != 'active'
       AND b.origin = 'human'${batch.sql}`,
    batch.params,
  );

  // A batch with no activities usually means tool events were dropped.
  add(
    {
      id: 'batch-zero-activities',
      layer: 'pipeline',
      severity: 'low',
      title: 'Completed human prompt batches with zero activities',
      detail:
        'A finished turn that recorded no tool activity. Legitimate for pure-conversation turns, so treat as a signal only when it clusters on one symbiont. Non-human origins are excluded: an injected envelope rarely drives tool use.',
    },
    `SELECT COUNT(*) n, MIN(b.created_at) first_seen, MAX(b.created_at) last_seen,
            GROUP_CONCAT(b.id) samples
     FROM prompt_batches b
     WHERE b.status != 'active' AND b.activity_count = 0
       AND b.origin = 'human'${batch.sql}`,
    batch.params,
  );

  // Denormalised counters drifting from reality means a write path bypassed
  // the counter update — the counter, not the data, is usually what is wrong.
  add(
    {
      id: 'session-counter-drift',
      layer: 'integrity',
      severity: 'medium',
      title: 'Sessions whose prompt_count disagrees with their batches',
      detail:
        'sessions.prompt_count caches MAX(prompt_number), not a row count — both writers in batches.ts derive it that way so the cache stays correct when a caller fills a gap. Drift means some write path inserted batches without bumping it.',
    },
    // MAX(prompt_number), NOT COUNT(*). prompt_number is legitimately
    // non-contiguous (reserved numbers, stranded batches), so a count-based
    // comparison reports every gap as drift.
    `SELECT COUNT(*) n, MIN(s.created_at) first_seen, MAX(s.created_at) last_seen,
            GROUP_CONCAT(s.id) samples
     FROM sessions s
     WHERE s.prompt_count != COALESCE(
       (SELECT MAX(pb.prompt_number) FROM prompt_batches pb WHERE pb.session_id = s.id), 0
     )${session.sql}`,
    session.params,
  );

  // Orphans should be impossible under the FK, so any row here means the
  // constraint was not enforced when it was written.
  add(
    {
      id: 'batch-orphaned',
      layer: 'integrity',
      severity: 'high',
      title: 'Prompt batches referencing a missing session',
      detail:
        'A foreign key to sessions(id) that does not resolve. Indicates rows written while enforcement was off.',
    },
    `SELECT COUNT(*) n, MIN(b.created_at) first_seen, MAX(b.created_at) last_seen,
            GROUP_CONCAT(b.id) samples
     FROM prompt_batches b
     LEFT JOIN sessions s ON s.id = b.session_id
     WHERE s.id IS NULL${batch.sql}`,
    batch.params,
  );

  return findings;
}
