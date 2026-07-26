import type { Database } from 'bun:sqlite';

import { isProjectPaused } from '@myco/grove/registry.js';

import { BUNDLED_TEMPLATES } from '../../../symbionts/templates.generated.js';
import { classifyRecency, scopeClause } from '../context.js';
import type { AuditOptions, CoverageGap, Finding } from '../types.js';

/**
 * Session closure has two legitimate modes: agents registering a SessionEnd
 * hook close at exit, and the rest close via the stale sweep. An open session
 * is therefore never a finding on its own — only a closure path that should
 * have run and did not.
 */

/** Agents that close a session from an exit hook rather than waiting on the sweep. */
export function hookClosingSymbionts(): Set<string> {
  const closing = new Set<string>();
  for (const [key, content] of Object.entries(BUNDLED_TEMPLATES)) {
    const match = /^([a-z0-9-]+)\/hooks\.json$/.exec(key);
    if (!match) continue;
    try {
      for (const event of Object.keys(JSON.parse(content) as Record<string, unknown>)) {
        if (/^session[-_]?end$/i.test(event)) closing.add(match[1]!);
      }
    } catch {
      // A template that will not parse is a separate problem; the installer
      // surfaces it. Treat the agent as sweep-closing rather than guessing.
    }
  }
  return closing;
}

export interface ClosureInput {
  /** `daemon.stale_session_threshold_ms` from live config. */
  staleThresholdMs: number;
  /** Epoch seconds of the last session-maintenance run, if known. */
  lastSweepAt?: number;
}

export function checkClosure(
  db: Database,
  opts: AuditOptions,
  now: number,
  input: ClosureInput,
): { findings: Finding[]; coverage: CoverageGap[] } {
  const findings: Finding[] = [];
  const coverage: CoverageGap[] = [];
  const hookClosing = hookClosingSymbionts();
  const thresholdSecs = Math.floor(input.staleThresholdMs / 1000);
  const scope = scopeClause('s', opts.projectId, opts.since);

  // Staleness is inactivity, not age: the newest of the last prompt and the
  // last activity, falling back to started_at when a session has neither.
  // Matches the predicate in `session-maintenance.ts`, so this selects the
  // same sessions the sweep selects.
  const rows = db
    .query(
      `SELECT s.agent agent, s.project_id project_id, COUNT(*) n,
              MIN(s.started_at) first_seen, MAX(s.started_at) last_seen,
              GROUP_CONCAT(s.id) samples
       FROM sessions s
       WHERE s.status = 'active'
         AND COALESCE(
           (SELECT MAX(touch) FROM (
             SELECT MAX(pb.started_at) AS touch
               FROM prompt_batches pb WHERE pb.session_id = s.id
             UNION ALL
             SELECT MAX(a.timestamp) AS touch
               FROM activities a WHERE a.session_id = s.id
           )),
           s.started_at
         ) < $cutoff${scope.sql}
       GROUP BY s.agent, s.project_id`,
    )
    .all({ ...scope.params, $cutoff: now - thresholdSecs }) as Array<{
    agent: string;
    project_id: string | null;
    n: number;
    first_seen: number | null;
    last_seen: number | null;
    samples: string | null;
  }>;

  // The sweep skips projects holding an active write lease, so their sessions
  // remaining open is expected. A read failure is treated as paused, matching
  // the sweep's fail-closed admission.
  const paused = new Map<string, boolean>();
  const isPaused = (projectId: string | null): boolean => {
    if (!projectId) return false;
    let value = paused.get(projectId);
    if (value === undefined) {
      try {
        value = isProjectPaused(projectId).paused;
      } catch {
        value = true;
      }
      paused.set(projectId, value);
    }
    return value;
  };

  for (const row of rows) {
    if (opts.symbiont && row.agent !== opts.symbiont) continue;
    if (isPaused(row.project_id)) continue;
    const samples = (row.samples ?? '').split(',').filter(Boolean).slice(0, 5);
    const isHookClosing = hookClosing.has(row.agent);

    // Two root causes that look identical in the table and are separated by a
    // single observation: did the sweep actually run since the threshold?
    const sweptSince = input.lastSweepAt !== undefined && input.lastSweepAt > now - thresholdSecs;

    if (isHookClosing) {
      findings.push({
        id: 'closure-exit-hook-missed',
        layer: 'pipeline',
        severity: 'medium',
        title: `${row.agent}: sessions past the stale threshold that close via an exit hook`,
        detail:
          `${row.agent} registers a SessionEnd hook, so these should have been closed at exit rather than left for the sweep. ` +
          'Check whether the exit hook fired at all — see the stop-hook-fragility skill.',
        count: row.n,
        symbiont: row.agent,
        firstSeen: row.first_seen ?? undefined,
        lastSeen: row.last_seen ?? undefined,
        recency: classifyRecency(row.last_seen, now),
        samples,
      });
      continue;
    }

    if (input.lastSweepAt === undefined) {
      coverage.push({
        symbiont: row.agent,
        scope: 'session closure',
        reason:
          `${row.n} session(s) past the stale threshold, but the last session-maintenance run time is unknown, ` +
          'so "the sweep missed them" cannot be told apart from "the sweep has not run". Supply lastSweepAt to resolve.',
      });
      continue;
    }

    findings.push(
      sweptSince
        ? {
            id: 'closure-sweep-missed',
            layer: 'pipeline',
            severity: 'high',
            title: `${row.agent}: stale sweep ran but left sessions open`,
            detail:
              'The session-maintenance sweep ran after these passed the threshold and did not close them. The defect is in the sweep, not the schedule.',
            count: row.n,
            symbiont: row.agent,
            firstSeen: row.first_seen ?? undefined,
            lastSeen: row.last_seen ?? undefined,
            recency: classifyRecency(row.last_seen, now),
            samples,
          }
        : {
            id: 'closure-sweep-not-running',
            layer: 'pipeline',
            severity: 'high',
            title: `${row.agent}: sessions past the threshold and no sweep has run`,
            detail:
              'SESSION_MAINTENANCE is a PowerManager job registered runIn active/idle/sleep — it fires on power-state transitions, not on a wall clock. A machine that never changes state never runs it. Investigate job scheduling, not session code.',
            count: row.n,
            symbiont: row.agent,
            firstSeen: row.first_seen ?? undefined,
            lastSeen: row.last_seen ?? undefined,
            recency: classifyRecency(row.last_seen, now),
            samples,
          },
    );
  }

  return { findings, coverage };
}
