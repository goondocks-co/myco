import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';

import { phaseSessionId } from '@myco/agent/wave-computation.js';

/**
 * Session ids belonging to Myco's own agent harness.
 *
 * A harness phase's session id is `sha256(runId + "-" + phaseName)` formatted
 * as a UUID, so the set is recomputable from `agent_runs` without reading a
 * transcript or matching prompt text. Matching on text would classify any real
 * session that merely discusses the agent as a harness run — the same
 * prefix-brittle failure that manifest drop rules have already suffered.
 *
 * Coverage is bounded by `agent_runs` retention: a run whose row has aged out
 * cannot be recomputed, so this identifies a subset, never a superset. Callers
 * pair it with the redirect epoch, which bounds what remains.
 */

/** Phase names any task declares, read from the task definitions on disk. */
function declaredPhaseNames(tasksDir: string): Set<string> {
  const names = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.yaml'));
  } catch {
    return names;
  }
  for (const entry of entries) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(tasksDir, entry), 'utf8');
    } catch {
      continue;
    }
    for (const line of source.split('\n')) {
      const match = /^\s*-\s*name:\s*([a-z0-9][a-z0-9-]*)\s*$/.exec(line);
      if (match) names.add(match[1]!);
    }
  }
  return names;
}

export function harnessSessionIds(db: Database, tasksDir: string): Set<string> {
  const ids = new Set<string>();
  const phases = declaredPhaseNames(tasksDir);
  if (phases.size === 0) return ids;

  let runs: Array<{ id: string }>;
  try {
    runs = db.query(`SELECT id FROM agent_runs`).all() as Array<{ id: string }>;
  } catch {
    return ids; // vault without the table
  }

  for (const run of runs) {
    for (const phase of phases) ids.add(phaseSessionId(run.id, phase));
  }
  return ids;
}
