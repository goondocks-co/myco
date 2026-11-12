/**
 * The recall gold set as the parity eval reads it: the cases, the corpus they
 * are scored against, and the frozen vectors behind both.
 *
 * `tests/fixtures/evals/recall/PROVENANCE.md` says where each piece came from.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expectPersisted } from '../harness.ts';
import { event } from '../clients/requests.ts';
import type { IdentityTarget } from '../clients/identity.ts';
import { fixtureLookup, type VectorIndexFile } from './lookup.ts';
import { joinMember } from '../clients/identity.ts';
import { asMember } from '../clients/runs.ts';
import type { GoldCase, MustNotSummary } from './score.ts';

export const FIXTURE_DIR = path.resolve(import.meta.dir, '..', '..', 'fixtures', 'evals', 'recall');

export interface CorpusSpore { id: string; observationType: string; status: string; content: string; agentLine: string | null; createdAt: number | null; embedKey: string }
export interface CorpusPlan { planKey: string; title: string | null; status: string; content: string; embedKey: string }
export interface Corpus { spores: CorpusSpore[]; plans: CorpusPlan[] }
export interface GoldFile { version: 1; maxPerPrompt: number; precisionRatchet: MustNotSummary & { reason: string }; cases: Array<GoldCase & { class: string; provenance: Record<string, unknown> }> }

const json = <T,>(name: string): T => JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as T;

export function loadRecallFixture() {
  const gold = json<GoldFile>('gold.json');
  const corpus = json<Corpus>('corpus.json');
  const index = json<VectorIndexFile>('vectors.json');
  const bytes = readFileSync(path.join(FIXTURE_DIR, 'vectors.bin'));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { gold, corpus, index, data, lookup: fixtureLookup(index, data) };
}

/** Imports the frozen identities and source times through the same channel as a member's legacy import. */
export async function importCorpus(target: IdentityTarget, corpus: Corpus): Promise<void> {
  const importers = await Promise.all(Array.from({ length: 4 }, async () => asMember(target, (await joinMember(target)).token)));
  for (const [index, spore] of corpus.spores.entries()) {
    const importer = importers[index % importers.length]!;
    await expectPersisted(await fetch(`${target.url}/spores/save`, { method: 'POST', headers: importer.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ channel: 'import', id: spore.id, agentId: 'recall-gold', observationType: spore.observationType, content: spore.content, agentLine: spore.agentLine, createdAt: spore.createdAt, status: spore.status }) }), `corpus ${spore.id}`);
  }
  const sessionId = 'recall-gold';
  await event(target, sessionId, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
  for (const plan of corpus.plans) await event(target, sessionId, 'plan', { planKey: plan.planKey, title: plan.title, status: plan.status, content: plan.content }, Date.now(), target.projectId, { channel: 'import' });
}
