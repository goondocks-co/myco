import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { createBackup, backupArtifact } from '@myco-server-worker/core/backup.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { assertRawPrivacy } from '../parity/scenarios/raw-privacy.js';
import type { ParityTarget } from '../parity/harness.js';
import { envelope, memberHeaders, memberPost, registeredObject, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie, SESSION_SECRET } from './helpers/owner.js';

describe('raw capture privacy regression gate', () => {
  it('admits only the historical member for raw event payloads, independently of token expiry and run or grant identity', async () => {
    const e = sqliteEnv();
    try {
      const token = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
      const payload = { trigger: 'auto', summary: 'original raw event payload' };
      const captured = envelope({ kind: 'compaction.pre', payload });
      expect(await (await worker.fetch(memberPost(token.token, captured), e.env)).json()).toMatchObject({ persisted: true });
      e.sqlite.query(`UPDATE member_credentials SET expires_at = 0, revoked_at = 1 WHERE id = ?`).run(token.tokenId);
      const resourceId = captured.eventId as string;
      const read = (memberId: string, projectId = 'proj_1') => new RawResourceReader(e.serverEnv, { projectId }, { kind: 'member', memberId }).event(resourceId);
      expect(await read('mem_machine_2')).toBe(JSON.stringify(payload));
      for (const memberId of ['mem_machine_1', 'mem_machine_3', 'mem_machine_4']) expect(await read(memberId)).toBeNull();
      expect(await read('mem_machine_2', 'proj_2')).toBeNull();
      for (const kind of ['run', 'grant'] as const) {
        expect(await new RawResourceReader(e.serverEnv, { projectId: 'proj_1' }, { kind, id: 'mem_machine_2' }).event(resourceId)).toBeNull();
      }
      e.sqlite.query(`UPDATE members SET revoked_at = 1 WHERE id = 'mem_machine_2'`).run();
      expect(await read('mem_machine_2')).toBeNull();
    } finally { e.sqlite.close(); }
  });

  it('holds the raw and processed HTTP contract for uploader, other member, admin and owner', async () => {
    const e = sqliteEnv();
    const cookie = await ownerCookie();
    const target: ParityTarget = {
      name: 'cloudflare', url: 'https://s', projectId: 'proj_1', memberToken: 'unused',
      ownerHeaders: () => ({ cookie, 'cf-connecting-ip': '1.2.3.4' }),
      memberHeaders: (extra) => memberHeaders('unused', extra), grantHeaders: () => ({}),
      sql: async (sql) => e.sqlite.query(sql).all() as Record<string, unknown>[],
      clockWake: async () => {}, stop: async () => {},
    };
    try {
      await assertRawPrivacy(target, async (request) => {
        const before = e.bucket.gets.length;
        const response = await worker.fetch(request, { ...e.env, ...OWNER_ENV });
        if (request.method === 'GET' && new URL(request.url).pathname.includes('/blobs/') && response.status !== 200) {
          expect(e.bucket.gets.length).toBe(before);
        }
        return response;
      }, SESSION_SECRET);

      const rawEvent = e.sqlite.query(`SELECT event_id, payload FROM events WHERE project_id = 'proj_raw_privacy' AND kind = 'transcript.segment'`).get() as { event_id: string; payload: string };
      const ownReader = new RawResourceReader(e.serverEnv, { projectId: 'proj_raw_privacy' }, { kind: 'member', memberId: 'mem_raw_other' });
      const ownerReader = new RawResourceReader(e.serverEnv, { projectId: 'proj_raw_privacy' }, { kind: 'member', memberId: 'mem_machine_1' });
      expect(await ownReader.event(rawEvent.event_id)).toBeNull();
      expect(await ownerReader.event(rawEvent.event_id)).toBeNull();

      const uploads = e.sqlite.query(`SELECT key FROM blobs WHERE project_id = 'proj_raw_privacy' AND token_id = 'mt_raw_uploader'`).all() as { key: string }[];
      const bytesBefore = uploads.map(({ key }) => ({ key, bytes: e.bucket.objects.get(registeredObject(e.sqlite, 'proj_raw_privacy', key)!)!.bytes.slice() }));
      await parseTranscripts(e.serverEnv, Date.now());
      const transcript = e.sqlite.query(`SELECT parsed_offset, size, parse_error FROM transcripts WHERE project_id = 'proj_raw_privacy' AND machine_id = 'machine_raw_uploader'`).get() as { parsed_offset: number; size: number; parse_error: string | null };
      expect(transcript).toEqual({ parsed_offset: transcript.size, size: transcript.size, parse_error: null });
      expect(e.sqlite.query(`SELECT text FROM prompt_batches WHERE project_id = 'proj_raw_privacy' AND text = 'processed prompt'`).all()).toEqual([{ text: 'processed prompt' }]);

      const provenanceBefore = e.sqlite.query<Record<string, unknown>, []>(`SELECT * FROM raw_resources ORDER BY rowid`).all();
      const backup = await createBackup(e.db, e.bucket, { producer: 'privacy regression', now: Date.now() });
      const artifact = await backupArtifact(e.db, e.bucket, backup.id);
      expect(artifact).not.toBeNull();
      const rows = artifact!.text.trim().split('\n').map((line) => JSON.parse(line) as { t?: string; r?: Record<string, unknown> });
      expect(rows.filter((row) => row.t === 'raw_resources').map((row) => row.r)).toEqual(provenanceBefore);
      expect(rows.find((row) => row.t === 'events' && row.r?.event_id === rawEvent.event_id)?.r?.payload).toBe(rawEvent.payload);
      for (const held of bytesBefore) expect(e.bucket.objects.get(registeredObject(e.sqlite, 'proj_raw_privacy', held.key)!)!.bytes).toEqual(held.bytes);
    } finally { e.sqlite.close(); }
  });
});
