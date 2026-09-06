import { cosineSimilarity } from './vectors.js';
import type { EmbeddingContext, EmbeddingStep } from './reconcile.js';

const HUBNESS_PAGE = 50;
export const CURRENT_SPORE_VECTORS = `SELECT r.id FROM embedding_receipts r JOIN embedding_sources s
  ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
  WHERE r.project_id = ? AND r.model_key = ? AND r.type = 'spore' AND r.ready = 1`;

/** One target's population-distance moments advance by one bounded page per step. */
export async function reconcileHubness(context: EmbeddingContext, projectId: string): Promise<EmbeddingStep> {
  const { db, vectors, provider } = context;
  const scope = { projectId, modelKey: provider.modelKey };
  const count = (await db.prepare(`SELECT COUNT(*) AS n FROM (${CURRENT_SPORE_VECTORS})`).bind(projectId, provider.modelKey).first<{ n: number }>())!.n;
  const cursor = await db.prepare('SELECT * FROM embedding_cursors WHERE project_id = ?').bind(projectId)
    .first<{ hubness_model: string | null; hubness_count: number | null; hubness_target_count: number | null; hubness_cursor: string | null }>();
  if (count < 2 || cursor?.hubness_model === provider.modelKey && cursor.hubness_count === count) return { phase: 'settled', processed: 0 };
  const reset = cursor?.hubness_model !== provider.modelKey || cursor.hubness_target_count !== count;
  if (reset) await db.batch([
    db.prepare(`INSERT INTO embedding_cursors(project_id, hubness_model, hubness_target_count) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET hubness_model = excluded.hubness_model, hubness_target_count = excluded.hubness_target_count,
      hubness_count = NULL, hubness_cursor = NULL`).bind(projectId, provider.modelKey, count),
    db.prepare('DELETE FROM embedding_hubness_work WHERE project_id = ?').bind(projectId),
  ]);
  const target = await db.prepare(`${CURRENT_SPORE_VECTORS} AND r.id > ? ORDER BY r.id LIMIT 1`)
    .bind(projectId, provider.modelKey, reset ? '' : cursor?.hubness_cursor ?? '').first<{ id: string }>();
  if (target === null) {
    await db.prepare('UPDATE embedding_cursors SET hubness_count = ?, hubness_cursor = NULL WHERE project_id = ?').bind(count, projectId).run();
    return { phase: 'settled', processed: 0 };
  }
  const [held] = await vectors.get(scope, [target.id]);
  if (held === undefined) return { phase: 'visibility', processed: 0 };
  const work = await db.prepare('SELECT * FROM embedding_hubness_work WHERE project_id = ? AND target = ?').bind(projectId, target.id)
    .first<{ after_id: string; count: number; mean: number; m2: number }>();
  const page = (await db.prepare(`${CURRENT_SPORE_VECTORS} AND r.id > ? ORDER BY r.id LIMIT ?`)
    .bind(projectId, provider.modelKey, work?.after_id ?? '', HUBNESS_PAGE).all<{ id: string }>()).results;
  const neighbors = await vectors.get(scope, page.map((r) => r.id));
  if (neighbors.length !== page.length) return { phase: 'visibility', processed: 0 };
  let n = work?.count ?? 0, mean = work?.mean ?? 0, m2 = work?.m2 ?? 0;
  for (const v of neighbors) {
    if (v.id === target.id) continue;
    const distance = 1 - cosineSimilarity(held.values, v.values);
    n++;
    const delta = distance - mean;
    mean += delta / n;
    m2 += delta * (distance - mean);
  }
  if (page.length === HUBNESS_PAGE) {
    await db.prepare(`INSERT INTO embedding_hubness_work(project_id, target, after_id, count, mean, m2) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET target = excluded.target, after_id = excluded.after_id, count = excluded.count, mean = excluded.mean, m2 = excluded.m2`)
      .bind(projectId, target.id, page[page.length - 1].id, n, mean, m2).run();
  } else {
    await db.batch([
      db.prepare('UPDATE embedding_receipts SET neighbor_mean = ?, neighbor_std = ? WHERE project_id = ? AND model_key = ? AND id = ?')
        .bind(n === 0 ? null : mean, n === 0 ? null : Math.sqrt(Math.max(0, m2 / n)), projectId, provider.modelKey, target.id),
      db.prepare('UPDATE embedding_cursors SET hubness_cursor = ? WHERE project_id = ?').bind(target.id, projectId),
      db.prepare('DELETE FROM embedding_hubness_work WHERE project_id = ?').bind(projectId),
    ]);
  }
  return { phase: 'hubness', processed: 1 };
}
