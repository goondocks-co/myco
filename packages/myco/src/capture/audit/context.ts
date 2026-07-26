import type { Database } from 'bun:sqlite';

import { BUNDLED_MANIFESTS } from '../../symbionts/manifests.generated.js';
import { SymbiontRegistry } from '../../symbionts/registry.js';
import { manifestTranscriptDiscovery } from '../../symbionts/transcript-discovery.js';
import type { CaptureModel, Finding, Recency, SymbiontContext } from './types.js';

/**
 * Myco captures through two models, and conflating them is the single largest
 * source of false findings.
 *
 * Hook-and-mining agents register events and have their transcripts mined.
 * Plugin-reported agents (pi, opencode, cline) run a Myco plugin that posts
 * complete events straight to the daemon — `opencode/plugin.ts` states it
 * outright: "Opencode has no on-disk transcript for Myco to mine." For those,
 * a NULL `transcript_path` is correct, and any transcript-shaped check must
 * skip them rather than report them as loss.
 *
 * The discriminator is adapter registration, which is the live runtime truth,
 * rather than a second declaration that could drift from it.
 */
export function captureModel(name: string, registry = new SymbiontRegistry()): CaptureModel {
  return registry.getAdapter(name) ? 'hook-and-mining' : 'plugin-reported';
}

export function symbiontContexts(filter?: string): SymbiontContext[] {
  const registry = new SymbiontRegistry();
  return BUNDLED_MANIFESTS.filter((m) => !filter || m.name === filter).map((m) => {
    const discovery = manifestTranscriptDiscovery(m.name);
    return {
      name: m.name,
      model: captureModel(m.name, registry),
      hasDiscovery: Boolean(discovery),
      canAttributeProject: Boolean(discovery?.transcriptCwdPath),
    };
  });
}

/**
 * Classify a finding by whether it is still accruing.
 *
 * `activeWindowSecs` defaults to 14 days: a class with nothing newer than that
 * is treated as a closed backlog. The audit reports the dates it used and
 * never claims which release caused a cutoff — attributing that is human
 * judgment.
 */
export function classifyRecency(
  lastSeen: number | null | undefined,
  now: number,
  activeWindowSecs = 14 * 24 * 60 * 60,
): Recency {
  if (!lastSeen) return 'unknown';
  return now - lastSeen <= activeWindowSecs ? 'active' : 'legacy';
}

/** Narrow a query to a project and time window without duplicating SQL per check. */
export function scopeClause(
  alias: string,
  projectId?: string,
  since?: number,
): { sql: string; params: Record<string, string | number> } {
  const parts: string[] = [];
  const params: Record<string, string | number> = {};
  if (projectId) {
    parts.push(`${alias}.project_id = $projectId`);
    params.$projectId = projectId;
  }
  if (since) {
    parts.push(`${alias}.created_at >= $since`);
    params.$since = since;
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

/**
 * Build a finding from an aggregate query shaped as
 * `count, first_seen, last_seen, samples`.
 */
export function findingFrom(
  base: Omit<Finding, 'count' | 'recency' | 'firstSeen' | 'lastSeen' | 'samples'>,
  row: { n: number; first_seen: number | null; last_seen: number | null; samples: string | null },
  now: number,
): Finding {
  return {
    ...base,
    count: row.n,
    firstSeen: row.first_seen ?? undefined,
    lastSeen: row.last_seen ?? undefined,
    recency: classifyRecency(row.last_seen, now),
    samples: (row.samples ?? '').split(',').filter(Boolean).slice(0, 5),
  };
}

/** Read a single aggregate row, tolerating an absent table on older vaults. */
export function aggregate(
  db: Database,
  sql: string,
  params: Record<string, string | number> = {},
): { n: number; first_seen: number | null; last_seen: number | null; samples: string | null } | null {
  try {
    return db.query(sql).get(params) as never;
  } catch {
    return null;
  }
}
