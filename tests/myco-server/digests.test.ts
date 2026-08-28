/**
 * Digest extracts, and the archive that makes a replacement non-destructive.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { getDigest, listDigestRevisions, listDigests, upsertDigest } from '@myco-server-worker/core/digests.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  for (const p of [SCOPE.projectId, OTHER.projectId]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  return { db: sqliteRelationalStore(sqlite), sqlite };
}

const digest = (id: string, content: string, tier = 5000, over: Record<string, unknown> = {}) => ({
  id, agentId: AGENT, tier, content, substrateHash: 'h', generatedAt: NOW, ...over,
});

describe('digest extracts', () => {
  it('archives nothing on a first write', async () => {
    const { db } = store();
    await upsertDigest(db, SCOPE, digest('d1', 'first'));
    expect((await getDigest(db, SCOPE, AGENT, 5000))?.content).toBe('first');
    expect(await listDigestRevisions(db, SCOPE, AGENT, 5000)).toEqual([]);
  });

  it('archives the body it replaces, so no digest is lost by being replaced', async () => {
    const { db } = store();
    await upsertDigest(db, SCOPE, digest('d1', 'first'));
    await upsertDigest(db, SCOPE, digest('d1', 'second', 5000, { generatedAt: NOW + 10 }));
    await upsertDigest(db, SCOPE, digest('d1', 'third', 5000, { generatedAt: NOW + 20 }));

    expect((await getDigest(db, SCOPE, AGENT, 5000))?.content).toBe('third');
    // Newest first: the body each write displaced.
    expect((await listDigestRevisions(db, SCOPE, AGENT, 5000)).map((r) => r.content)).toEqual(['second', 'first']);
  });

  it('chains each archived body to the one before it', async () => {
    const { db } = store();
    await upsertDigest(db, SCOPE, digest('d1', 'first'));
    await upsertDigest(db, SCOPE, digest('d1', 'second', 5000, { generatedAt: NOW + 10 }));
    await upsertDigest(db, SCOPE, digest('d1', 'third', 5000, { generatedAt: NOW + 20 }));

    const revisions = await listDigestRevisions(db, SCOPE, AGENT, 5000);
    const [newest, oldest] = revisions;
    expect(oldest.parentRevisionId).toBeNull();
    expect(newest.parentRevisionId).toBe(oldest.id);
  });

  it('records what produced the replacement on the revision it archives', async () => {
    const { db } = store();
    await upsertDigest(db, SCOPE, digest('d1', 'first'));
    await upsertDigest(db, SCOPE, digest('d1', 'second', 5000, { generatedAt: NOW + 10, runId: null, metadata: '{"by":"digest-only"}' }));
    expect((await listDigestRevisions(db, SCOPE, AGENT, 5000))[0].metadata).toBe('{"by":"digest-only"}');
  });

  it('keeps one current digest per tier and does not archive across tiers', async () => {
    const { db } = store();
    await upsertDigest(db, SCOPE, digest('d1', 'small', 1500));
    await upsertDigest(db, SCOPE, digest('d2', 'large', 5000));
    await upsertDigest(db, SCOPE, digest('d2', 'large-2', 5000, { generatedAt: NOW + 10 }));

    expect((await listDigests(db, SCOPE)).map((d) => [d.tier, d.content])).toEqual([[1500, 'small'], [5000, 'large-2']]);
    expect(await listDigestRevisions(db, SCOPE, AGENT, 1500)).toEqual([]);
    expect((await listDigestRevisions(db, SCOPE, AGENT, 5000)).map((r) => r.content)).toEqual(['large']);
  });

  it('keeps the digests and history of each Project to itself', async () => {
    const { db } = store();
    await upsertDigest(db, SCOPE, digest('d1', 'mine'));
    await upsertDigest(db, OTHER, digest('d2', 'theirs'));
    await upsertDigest(db, OTHER, digest('d2', 'theirs-2', 5000, { generatedAt: NOW + 10 }));

    expect((await getDigest(db, SCOPE, AGENT, 5000))?.content).toBe('mine');
    expect(await listDigestRevisions(db, SCOPE, AGENT, 5000)).toEqual([]);
    expect((await listDigestRevisions(db, OTHER, AGENT, 5000)).map((r) => r.content)).toEqual(['theirs']);
  });
});
