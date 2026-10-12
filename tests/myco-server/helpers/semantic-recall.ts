import type { RelationalStore } from '../../../packages/myco-server/src/core/adapters.js';
import type { ReadScope } from '../../../packages/myco-server/src/read/scope.js';
import type { SemanticSearch, EmbeddingSource } from '../../../packages/myco-server/src/read/embedding.js';
import { vectorId, vectorMatches } from '../../../packages/myco-server/src/core/embedding/vectors.js';

/**
 * A controlled relevance distribution for recall's gating and recording
 * contracts, over every embeddable type the selector queries.
 *
 * Spores and plans both reach the prompt selector, so the fixture scores both
 * and lets `vectorMatches` apply each query's own filter. A plan always scores
 * below every spore, which is the order the selector's drop rule assumes.
 */
export function semanticRecall(db: RelationalStore, scope: ReadScope, options: { backgroundSpores?: boolean } = {}): () => Promise<SemanticSearch> {
  return async () => {
    const modelKey = 'recall-fixture';
    const partition = { projectId: scope.projectId, modelKey };
    const agent = await db.prepare('SELECT id FROM agents LIMIT 1').first<{ id: string }>();
    if (agent === null) throw new Error('recall fixture requires an agent');
    for (let i = 0; i < (options.backgroundSpores === false ? 0 : 24); i++) await db.prepare(`INSERT OR IGNORE INTO spores(project_id, id, agent_id, content, observation_type, created_at)
      VALUES (?, ?, ?, 'Unrelated background observation', 'gotcha', 0)`).bind(scope.projectId, `background-${i}`, agent.id).run();
    const sources = (await db.prepare(`SELECT * FROM embedding_sources WHERE project_id = ? AND type IN ('spore', 'plan') ORDER BY type ASC, created_at DESC, record_id DESC`)
      .bind(scope.projectId).all<EmbeddingSource>()).results;
    const scored = await Promise.all(sources.map(async (source, i) => {
      const id = await vectorId(partition, source.type, source.record_id, source.revision);
      await db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id, model_key, id, type, record_id, revision, ready, updated_at, neighbor_mean, neighbor_std)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0.5, 0.1)`).bind(scope.projectId, modelKey, id, source.type, source.record_id, source.revision).run();
      const base = source.type === 'plan' ? 0.5 : 0.95;
      return { id, source, score: source.record_id.startsWith('background-') ? 0.2 + i / 1000 : base - i / 1000 };
    }));
    return {
      provider: { modelKey, embed: async () => [1, 0] },
      vectors: {
        query: async (asked, options) => asked.projectId !== scope.projectId || asked.modelKey !== modelKey ? []
          : scored.filter((s) => vectorMatches(s.source, options.filters)).slice(0, options.topK).map(({ id, score }) => ({ id, score })),
        get: async (asked, ids) => asked.projectId !== scope.projectId || asked.modelKey !== modelKey ? [] :
          scored.filter(s => s.source.type === 'spore' && ids.includes(s.id)).map(s => ({ id: s.id, metadata: s.source, values: [s.score, Math.sqrt(1 - s.score ** 2)] })),
        upsert: async () => { throw new Error('read-only recall fixture'); },
        delete: async () => { throw new Error('read-only recall fixture'); },
      },
    };
  };
}
