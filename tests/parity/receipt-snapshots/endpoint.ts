import type { RelationalStore } from '../../../packages/myco-server/src/core/adapters.js';
import { selectSporesForPrompt } from '../../../packages/myco-server/src/core/injection.js';
import { sessionWriteAdmission } from '../../../packages/myco-server/src/ingest/projections.js';
import { cosineSimilarity } from '../../../packages/myco-server/src/core/embedding/vectors.js';
import { semanticRecall } from '../../myco-server/helpers/semantic-recall.js';

/** The shipped selector and receipt writer with a controlled plan relevance distribution. */
export async function receiptSnapshotEndpoint(request: Request, db: RelationalStore): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/__receipt-snapshots') return null;
  const input = await request.json() as { projectId: string; sessionId: string; promptId: string };
  const scope = { projectId: input.projectId };
  try {
    const semantic = await semanticRecall(db, scope)();
    await db.prepare("UPDATE embedding_receipts SET neighbor_mean = 0.2, neighbor_std = 0.03 WHERE project_id = ? AND type = 'spore'")
      .bind(input.projectId).run();
    const rows = (await db.prepare("SELECT id FROM embedding_receipts WHERE project_id = ? AND type = 'plan' ORDER BY record_id")
      .bind(input.projectId).all<{ id: string }>()).results;
    const vectors = rows.map((row, i) => ({ id: row.id,
      metadata: { type: 'plan' as const, record_id: '', revision: '', status: '', session_id: '', created_at: 0,
        observation_type: '', release_state: '', release_confidence: '' },
      values: [0.8 - i / 100,
      Math.sqrt(1 - (0.8 - i / 100) ** 2) * Math.cos(i / 5), Math.sqrt(1 - (0.8 - i / 100) ** 2) * Math.sin(i / 5)] }));
    const query = [1, 0, 0];
    semantic.provider.embed = async () => query;
    semantic.vectors.get = async () => vectors;
    const originalQuery = semantic.vectors.query;
    semantic.vectors.query = async (partition, options) => options.filters?.type === 'plan'
      ? vectors.map(vector => ({ id: vector.id, score: cosineSimilarity(query, vector.values) }))
      : (await originalQuery(partition, options)).map((hit, i) => ({ ...hit, score: 0.7 - i / 1000 }));
    const result = await selectSporesForPrompt(db, scope, { enabled: true, maxPerPrompt: 7 }, true, {
      sessionId: input.sessionId, promptId: input.promptId, promptHash: input.promptId,
      prompt: 'Preserve pending transcript batches while a disconnected member reconnects and retries delivery.',
      now: Date.now(), admission: sessionWriteAdmission({ projectId: input.projectId, machineId: 'machine_parity' }, input.sessionId),
    }, async () => semantic);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
