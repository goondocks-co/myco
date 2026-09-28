/**
 * Runtime proof for spore calibration (#1429), on a local D1 in real workerd.
 *
 * The schema steps and every calibration statement run through a D1 binding, so what D1 accepts and how its batches
 * commit is D1's own answer: the guarded `WITH … UPDATE` over `json_each`, the token compare-and-swap, and the
 * membership record. Vectors come from the Vectorize fixture. Each check compares every current spore's published
 * statistics with a full recompute, and counts the calibration steps a change costs.
 *
 * Usage: bun tests/myco-server/runtime/embedding-hubness-runtime.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '../../../packages/myco-server/src/db/schema.js';
import { reconcileEmbedding, type EmbeddingContext } from '../../../packages/myco-server/src/core/embedding/reconcile.js';
import { hasEmbeddingWork } from '../../../packages/myco-server/src/core/embedding/jobs.js';
import { CURRENT_SPORE_VECTORS } from '../../../packages/myco-server/src/core/embedding/hubness.js';
import { cloudflareVectorStore } from '../../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { cosineSimilarity } from '../../../packages/myco-server/src/core/embedding/vectors.js';
import type { BlobStore, RelationalStore } from '../../../packages/myco-server/src/core/adapters.js';
import { indexFixture } from '../helpers/vector-index.js';

const EVIDENCE = process.env.MYCO_HUBNESS_EVIDENCE ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hubness-runtime-')), 'result.json');
const checks: Array<Record<string, unknown>> = [];
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 220)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** An eight-dimensional embedding drawn from the text. */
function embedding(text: string): number[] {
  let a = 2166136261;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619);
  return Array.from({ length: 8 }, () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  });
}

const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
try {
  const db = await mf.getD1Database('DB') as unknown as RelationalStore;
  for (const step of SCHEMA_STEPS) for (const sql of step.statements) await db.prepare(sql).run();
  await db.prepare("INSERT INTO projects(project_id, name, created_at) VALUES ('p', 'p', 1)").run();
  await db.prepare("INSERT INTO agents(id, name, source, enabled, created_at) VALUES ('a', 'a', 'built-in', 1, 1)").run();
  const vectors = cloudflareVectorStore(indexFixture());
  const context: EmbeddingContext = { db, blobs: {} as BlobStore, vectors, provider: { modelKey: 'm', embed: async (text) => embedding(text) } };
  const spore = (id: string, content: string) => db.prepare("INSERT INTO spores(project_id, id, agent_id, content, observation_type, created_at) VALUES ('p', ?, 'a', ?, 'decision', 1)").bind(id, content).run();
  const now = 10 ** 12;
  const settle = async () => {
    const phases: string[] = [];
    for (let i = 0; i < 500; i++) {
      const { phase, processed } = await reconcileEmbedding(context, 'p', now);
      phases.push(phase);
      if (processed === 0) return phases.filter((p) => p === 'hubness').length;
    }
    throw new Error('calibration did not settle');
  };
  const exact = async () => {
    const ids = (await db.prepare(`${CURRENT_SPORE_VECTORS} ORDER BY r.id`).bind('p', 'm').all<{ id: string }>()).results.map((r) => r.id);
    const held = new Map((await vectors.get({ projectId: 'p', modelKey: 'm' }, ids)).map((v) => [v.id, v.values]));
    let worst = 0;
    for (const id of ids) {
      let n = 0, mean = 0, m2 = 0;
      for (const other of ids) {
        if (other === id) continue;
        const d = 1 - cosineSimilarity(held.get(id)!, held.get(other)!);
        n++;
        const delta = d - mean;
        mean += delta / n;
        m2 += delta * (d - mean);
      }
      const row = (await db.prepare('SELECT neighbor_mean, neighbor_std FROM embedding_receipts WHERE id = ?').bind(id).first<{ neighbor_mean: number; neighbor_std: number }>())!;
      worst = Math.max(worst, Math.abs(row.neighbor_mean - mean), Math.abs(row.neighbor_std - Math.sqrt(m2 / n)));
    }
    const cursor = await db.prepare('SELECT hubness_count FROM embedding_cursors').first<{ hubness_count: number }>();
    return { spores: ids.length, withinTolerance: worst < 1e-12, hubnessCount: cursor?.hubness_count, pending: await hasEmbeddingWork(db, 'p', 'm', now) };
  };

  for (let i = 0; i < 120; i++) await spore(`s${String(i).padStart(3, '0')}`, `spore ${i}`);
  check('120 spores calibrate in operations of 20, one page of settled members per step', await settle(), 9);
  check('built: exact, counted, quiet', await exact(), { spores: 120, withinTolerance: true, hubnessCount: 120, pending: false });
  await spore('s999', 'one more spore');
  check('one spore added costs one step per page of the other 120', await settle(), 3);
  check('added: exact, counted, quiet', await exact(), { spores: 121, withinTolerance: true, hubnessCount: 121, pending: false });
  await db.prepare("UPDATE spores SET content = 'revised' WHERE id = 's005'").run();
  await db.prepare("DELETE FROM spores WHERE id = 's050'").run();
  check('a revision and a removal cost one leaving and one joining operation', await settle(), 6);
  check('changed: exact, counted, quiet', await exact(), { spores: 120, withinTolerance: true, hubnessCount: 120, pending: false });
} finally {
  await mf.dispose();
  fs.writeFileSync(EVIDENCE, JSON.stringify({ checks }, null, 2));
  console.log(`evidence: ${EVIDENCE}`);
}
