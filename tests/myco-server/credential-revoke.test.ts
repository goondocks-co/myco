import { describe, expect, it } from 'bun:test';
import { Miniflare } from 'miniflare';
import { createServer } from '@myco-server-worker/pipeline.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { memberHeaders, noOutboundFetch, sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_700_000_000_000;
const PATH = '/members/credential/revoke';

for (const target of ['native SQLite', 'Cloudflare D1'] as const) {
  describe(`${target}: member credential self-revocation`, () => {
    it('ends only the presented lineage and refuses its later use', async () => {
      const fixture = sqliteEnv();
      const mf = target === 'Cloudflare D1' ? new Miniflare({ modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        compatibilityDate: '2026-07-01', d1Databases: ['DB'] }) : null;
      try {
        const db: RelationalStore = mf === null ? fixture.db : await mf.getD1Database('DB') as unknown as RelationalStore;
        if (mf !== null) {
          for (const step of SCHEMA_STEPS) await db.batch(step.statements.map((sql) => db.prepare(sql)));
          await db.prepare("INSERT INTO members(id,label,created_at,role) VALUES ('mem_machine_1','one',0,'member'),('mem_machine_2','two',0,'member')").run();
          await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES ('machine_1','mem_machine_1',0),('machine_2','mem_machine_2',0)").run();
        }
        const root = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
        const successor = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW + 1,
          { predecessorId: root.tokenId, lineageRoot: root.tokenId, lineageStartedAt: NOW });
        const unrelated = await issueMemberToken(db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, NOW);
        const server = createServer({ now: () => NOW + 2, sourceOf: () => '192.0.2.1', fetchImpl: noOutboundFetch });
        const env = { ...fixture.serverEnv, db };
        const post = (token: string, body = '{}', path = PATH) => server.handleRequest(new Request(`https://s${path}`, {
          method: 'POST', headers: { ...memberHeaders(token, { [PROJECT_HEADER]: '' }), 'content-type': 'application/json' }, body,
        }), env);
        const rows = async () => (await db.prepare('SELECT id, revoked_at, revoked_by FROM member_credentials WHERE id IN (?, ?, ?) ORDER BY id')
          .bind(root.tokenId, successor.tokenId, unrelated.tokenId).all<{ id: string; revoked_at: number | null; revoked_by: string | null }>()).results;

        for (const body of ['not json', '{"tokenId":"' + unrelated.tokenId + '"}']) {
          const refused = await post(root.token, body);
          expect({ status: refused.status, body: await refused.json() }).toMatchObject({ status: 200, body: { persisted: false } });
        }
        expect((await rows()).every((row) => row.revoked_at === null)).toBe(true);

        const response = await post(root.token);
        expect({ status: response.status, protocol: response.headers.get(PROTOCOL_HEADER), body: await response.json() })
          .toEqual({ status: 200, protocol: String(SERVER_PROTOCOL), body: { persisted: true, revoked: 2 } });
        expect(await rows()).toEqual([
          { id: root.tokenId, revoked_at: NOW + 2, revoked_by: 'mem_machine_1' },
          { id: successor.tokenId, revoked_at: NOW + 2, revoked_by: 'mem_machine_1' },
          { id: unrelated.tokenId, revoked_at: null, revoked_by: null },
        ].sort((a, b) => a.id < b.id ? -1 : 1));
        expect((await post(root.token)).status).toBe(401);
        expect((await post(successor.token)).status).toBe(401);
        expect((await post(unrelated.token, '{}', '/members/status')).status).toBe(200);
      } finally {
        await mf?.dispose();
        fixture.sqlite.close();
      }
    }, 60_000);
  });
}
