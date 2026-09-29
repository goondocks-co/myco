/**
 * The recall gold set as the parity eval reads it: the cases, the corpus they
 * are scored against, and the frozen vectors behind both.
 *
 * `tests/fixtures/evals/recall/PROVENANCE.md` says where each piece came from.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lit } from '../harness.ts';
import { fixtureLookup, type VectorIndexFile } from './lookup.ts';
import type { GoldCase } from './score.ts';

export const FIXTURE_DIR = path.resolve(import.meta.dir, '..', '..', 'fixtures', 'evals', 'recall');

export interface CorpusSpore { id: string; observationType: string; status: string; content: string; agentLine: string | null; createdAt: number | null; embedKey: string }
export interface CorpusPlan { planKey: string; title: string | null; status: string; content: string; embedKey: string }
export interface Corpus { spores: CorpusSpore[]; plans: CorpusPlan[] }
export interface GoldFile { version: 1; maxPerPrompt: number; cases: Array<GoldCase & { class: string; provenance: Record<string, unknown> }> }

const json = <T,>(name: string): T => JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as T;

export function loadRecallFixture() {
  const gold = json<GoldFile>('gold.json');
  const corpus = json<Corpus>('corpus.json');
  const index = json<VectorIndexFile>('vectors.json');
  const bytes = readFileSync(path.join(FIXTURE_DIR, 'vectors.bin'));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { gold, corpus, index, data, lookup: fixtureLookup(index, data) };
}

/** Longest SQL text one seed statement carries; `wrangler d1 execute --command` passes it as one argument. */
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

/**
 * Single statements that seed the corpus into a Project, each reading its rows
 * from one JSON literal. One statement per call is what both targets' `sql`
 * run, and `json_each` keeps a statement to a single SELECT, which D1's
 * compound-select cap would refuse as a many-term VALUES list.
 */
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
