import { lit } from '../../parity/harness.ts';
import type { Corpus } from '../../parity/recall/fixture.ts';

/** Longest SQL text one native geometry fixture statement carries. */
const SEED_CHUNK_CHARS = 60_000;

function chunked<T>(rows: readonly T[], size: (row: T) => number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let length = 0;
  for (const row of rows) {
    const n = size(row);
    if (current.length > 0 && length + n > SEED_CHUNK_CHARS) { chunks.push(current); current = []; length = 0; }
    current.push(row);
    length += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Native selection geometry fixtures hold source identities independently of the HTTP eval's import channel. */
export function seedStatements(projectId: string, corpus: Corpus, agentId: string, now: number): string[] {
  const spores = chunked(corpus.spores, (s) => s.content.length + (s.agentLine?.length ?? 0) + 200).map((rows) => {
    const payload = rows.map((s) => ({ id: s.id, t: s.observationType, c: s.content, l: s.agentLine, at: s.createdAt ?? now }));
    return `INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, agent_line, created_at)
      SELECT ${lit(projectId)}, json_extract(j.value, '$.id'), ${lit(agentId)}, json_extract(j.value, '$.t'), 'active',
        json_extract(j.value, '$.c'), json_extract(j.value, '$.l'), json_extract(j.value, '$.at') FROM json_each(${lit(JSON.stringify(payload))}) j`;
  });
  const plans = chunked(corpus.plans, (p) => p.content.length + (p.title?.length ?? 0) + 200).map((rows) => {
    const payload = rows.map((p) => ({ k: p.planKey, t: p.title, s: p.status, c: p.content }));
    return `INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at)
      SELECT ${lit(projectId)}, json_extract(j.value, '$.k'), 'recall-gold', 'recall-gold-' || json_extract(j.value, '$.k'), 'recall-gold',
        json_extract(j.value, '$.t'), json_extract(j.value, '$.c'), 'recall-gold-' || json_extract(j.value, '$.k'), json_extract(j.value, '$.s'),
        ${now}, ${now}, 'recall-gold', ${now} FROM json_each(${lit(JSON.stringify(payload))}) j`;
  });
  return [...spores, ...plans];
}
