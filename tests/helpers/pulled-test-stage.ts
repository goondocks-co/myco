import type { PulledItem, PulledStage } from '../../packages/myco-server/src/core/pulled-stages.js';

/** The due items a test-only pulled stage offers; created by the fixture, never by the schema. */
export const PULL_FIXTURE_TABLE = `CREATE TABLE IF NOT EXISTS pull_fixture_items (project_id TEXT NOT NULL, item_id TEXT NOT NULL,
  level INTEGER NOT NULL, task TEXT NOT NULL, due_at INTEGER NOT NULL, PRIMARY KEY (project_id, item_id))`;

/** A test-only pulled stage at `level` for `task`; `build` runs during input preparation, where tests interleave changes. */
export function testPulledStage(level: number, task: string, build?: (item: PulledItem) => Promise<void> | void): PulledStage {
  const free = (alias: string) => `NOT EXISTS (SELECT 1 FROM agent_runs busy WHERE busy.task = '${task}'
    AND busy.status IN ('pending', 'running', 'queued') AND busy.subject = 'fixture:' || ${alias}.item_id)`;
  const due = (alias: string, project: string) => `${alias}.project_id = ${project} AND ${alias}.level = ${level} AND ${alias}.task = '${task}'
    AND ${alias}.due_at <= ? AND ${free(alias)}`;
  return {
    level,
    task,
    due: (project, now) => ({ sql: `EXISTS (SELECT 1 FROM pull_fixture_items i WHERE ${due('i', project)})`, params: [now] }),
    head: (db, projectId, now) => db.prepare(`SELECT i.project_id AS projectId, 'fixture:' || i.item_id AS subject, i.item_id AS key, i.due_at AS observed
      FROM pull_fixture_items i WHERE ${due('i', '?')} ORDER BY i.due_at, i.item_id LIMIT 1`).bind(projectId, now).first<PulledItem>(),
    stillHead: (item, now) => ({
      sql: `EXISTS (SELECT 1 FROM pull_fixture_items i WHERE i.project_id = ? AND i.item_id = ? AND i.due_at = ? AND i.due_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM pull_fixture_items o WHERE ${due('o', '?')} AND (o.due_at < ? OR (o.due_at = ? AND o.item_id < ?)))`,
      params: [item.projectId, item.key, item.observed, now, item.projectId, now, item.observed, item.observed, item.key],
    }),
    build: async (_env, item) => {
      await build?.(item);
      return { instruction: `fixture item ${item.key}`, inputHash: item.key, counts: {} };
    },
  };
}

/** The two test stages parity installs: two levels, two tasks. */
export const PARITY_PULLED_STAGES: readonly PulledStage[] = [testPulledStage(1, 'title-summary'), testPulledStage(2, 'canopy-map')];
