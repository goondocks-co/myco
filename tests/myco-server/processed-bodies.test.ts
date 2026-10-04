import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { isProcessedBodyKind, processedBody } from '@myco-server-worker/read/processed.js';
import { handlePlans } from '@myco-server-worker/mcp/tools/plans.js';
import { getPlan } from '@myco-server-worker/read/plans.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { pendingSearchBlobs, reconcileSearchIndex } from '@myco-server-worker/core/search-index.js';
import { registerBlob, seedCredential } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';

const BODY = 'Full processed text\n<script>inert text</script>\n- [x] Keep fidelity';
const HASH = 'a'.repeat(64);
const ID = 'field + # é';
const KINDS = ['prompt', 'response', 'plan', 'tool-input', 'tool-output'] as const;

function fixture(spilled = true) {
  const e = sqliteEnv();
  const uploadToken = seedCredential(e.sqlite, { id: 'upload-token', expiresAt: Date.now() + 60_000 });
  const bytes = new TextEncoder().encode(BODY);
  const object = registerBlob(e.sqlite, { projectId: 'proj_1', key: HASH, size: bytes.length, mediaType: 'text/html', tokenId: uploadToken });
  e.bucket.seed(object, { size: bytes.length, bytes, contentType: 'text/html' });
  const text = spilled ? null : BODY;
  const key = spilled ? HASH : null;
  e.sqlite.query(`INSERT INTO prompt_batches
    (project_id, prompt_id, session_id, event_id, origin, text, blob_key, content_hash, created_at, updated_at, token_id, received_at)
    VALUES ('proj_1', ?, 's', 'event-p', 'user', ?, ?, 'hash-p', 1, 1, ?, 1)`).run(ID, text, key, uploadToken);
  e.sqlite.query(`INSERT INTO responses
    (project_id, response_id, session_id, event_id, text, blob_key, content_hash, created_at, token_id, received_at)
    VALUES ('proj_1', ?, 's', 'event-r', ?, ?, 'hash-r', 1, ?, 1)`).run(ID, text, key, uploadToken);
  e.sqlite.query(`INSERT INTO plans
    (project_id, plan_key, session_id, event_id, machine_id, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
    VALUES ('proj_1', ?, 's', 'event-plan', 'machine_1', ?, ?, 'hash-plan', 'active', 1, 1, ?, 1)`).run(ID, text, key, uploadToken);
  e.sqlite.query(`INSERT INTO tool_calls
    (project_id, tool_call_id, session_id, event_id, tool_name, input, input_blob_key, output_preview, output_blob_key, success, created_at, token_id, received_at)
    VALUES ('proj_1', ?, 's', 'event-tool', 'Read', ?, ?, ?, ?, 1, 1, ?, 1)`).run(ID, text, key, spilled ? 'preview only' : text, key, uploadToken);
  const env = { ...e.env, ...OWNER_ENV };
  const get = async (kind: string, id = ID, project = 'proj_1') => worker.fetch(await asOwner(`/api/projects/${project}/processed/${kind}/${encodeURIComponent(id)}`), env);
  return { ...e, env, object, get };
}

describe('typed processed fields', () => {
  it('serves every complete processed field identically inline or spilled, with inert content and no browser caching', async () => {
    for (const spilled of [false, true]) {
      const e = fixture(spilled);
      for (const kind of KINDS) {
        const response = await e.get(kind);
        expect({ kind, spilled, status: response.status, text: await response.text() }).toEqual({ kind, spilled, status: 200, text: BODY });
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      }
      expect(e.bucket.gets.length).toBe(spilled ? KINDS.length : 0);
    }
  });

  it('resolves only a typed row in the named project, never a hash, event, transcript, or uploaded attachment', async () => {
    const e = fixture();
    for (const kind of ['events', 'transcript', 'attachment', 'blobs', '__proto__', 'constructor']) {
      expect(isProcessedBodyKind(kind)).toBe(false);
      expect((await e.get(kind, HASH)).status).toBe(401);
    }
    for (const kind of KINDS) {
      const response = await e.get(kind, HASH);
      expect({ kind, status: response.status }).toEqual({ kind, status: 404 });
    }
    for (const project of ['proj_2', 'missing']) expect((await e.get('plan', ID, project)).status).toBe(404);
    expect(e.bucket.gets).toEqual([]);
    expect(e.executed.some((sql) => /FROM (events|transcripts|transcript_segments|attachments)\b/.test(sql))).toBe(false);
  });

  it('uses the same typed plan field in MCP and HTTP', async () => {
    const e = fixture();
    const mcp = await handlePlans({ op: 'get', id: ID }, {
      env: e.serverEnv, projectId: 'proj_1', now: Date.now(),
      principal: { kind: 'member', memberId: 'mem_machine_2', machineId: 'machine_2', tokenId: 'caller' },
    });
    expect(mcp).toMatchObject({ id: ID, content: BODY });
    expect(await (await e.get('plan')).text()).toBe(BODY);
  });

  it('surfaces a lost stored processed body instead of answering no text', async () => {
    const e = fixture();
    e.bucket.objects.delete(e.object);
    await expect(processedBody(e.serverEnv, { projectId: 'proj_1' }, 'plan', ID)).rejects.toThrow('Processed body stored object is missing');
    expect((await e.get('plan')).status).toBe(503);
  });

  it('refuses a foreign uploader’s projected pointer before reading bytes, even when the same hash backs a valid shared field', async () => {
    const e = fixture();
    const foreignToken = seedCredential(e.sqlite, { id: 'foreign-token', memberId: 'mem_machine_2', machineId: 'machine_2', expiresAt: Date.now() + 60_000 });
    e.sqlite.query(`INSERT INTO plans
      (project_id, plan_key, session_id, event_id, machine_id, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', 'foreign', 'foreign-s', 'foreign-event', 'machine_2', NULL, ?, 'foreign-hash', 'active', 1, 1, ?, 1)`).run(HASH, foreignToken);
    expect((await e.get('plan', 'foreign')).status).toBe(503);
    expect((await getPlan(e.db, { projectId: 'proj_1' }, 'foreign'))?.objectKey).toBeNull();
    expect((await getPlan(e.db, { projectId: 'proj_1' }, ID))?.objectKey).toBe(e.object);
    expect(e.bucket.gets).toEqual([]);
    await expect(handlePlans({ op: 'get', id: 'foreign' }, {
      env: e.serverEnv, projectId: 'proj_1', now: Date.now(),
      principal: { kind: 'member', memberId: 'mem_machine_2', machineId: 'machine_2', tokenId: foreignToken },
    })).rejects.toThrow('Processed body has no admitted field provenance');
    expect(e.bucket.gets).toEqual([]);
    expect(await (await e.get('plan')).text()).toBe(BODY);

    e.sqlite.query(`INSERT INTO search_blob_chunks (project_id, blob_key, offset, text) VALUES ('proj_1', ?, 0, ?)`).run(HASH, BODY);
    for (const query of ['processed', 'processed fidelity']) {
      const found = await searchProject(e.db, { projectId: 'proj_1' }, { query, type: 'plan', mode: 'fts' });
      expect(found.results.map((row) => row.id)).toEqual([ID]);
      expect(found.results[0]?.preview).toContain('processed');
    }
    expect(e.sqlite.query(`SELECT record_id FROM embedding_sources WHERE project_id = 'proj_1' AND type = 'plan'`).all()).toEqual([{ record_id: ID }]);

    e.sqlite.query(`DELETE FROM plans WHERE project_id = 'proj_1' AND plan_key = ?`).run(ID);
    e.sqlite.query(`DELETE FROM prompt_batches WHERE project_id = 'proj_1'`).run();
    e.sqlite.query(`DELETE FROM responses WHERE project_id = 'proj_1'`).run();
    e.sqlite.query(`DELETE FROM tool_calls WHERE project_id = 'proj_1'`).run();
    const reads = e.bucket.gets.length;
    expect(await pendingSearchBlobs(e.db, 'proj_1')).toBe(0);
    expect(await reconcileSearchIndex(e.db, e.bucket, Date.now())).toBe(0);
    expect(e.bucket.gets.length).toBe(reads);
    expect((await searchProject(e.db, { projectId: 'proj_1' }, { query: 'processed', type: 'plan', mode: 'fts' })).results).toEqual([]);
    expect(e.sqlite.query(`SELECT record_id FROM embedding_sources WHERE project_id = 'proj_1' AND type = 'plan'`).all()).toEqual([]);
  });
});
