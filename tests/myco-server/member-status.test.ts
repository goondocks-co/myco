/**
 * `POST /members/status`: the Deployment's health a member credential reads —
 * the target, the schema check, the bytes this credential stored (information,
 * never a limit), the transcript retention window, and the storage
 * measurements store maintenance last recorded, blob bytes among them — over
 * an empty body, resolving no Project, and to no credential but
 * a member's.
 */
import { describe, expect, it } from 'bun:test';
import { jsonBody } from '../helpers/json-body.js';
import worker from '@myco-server-worker/index.js';
import { handleMemberStatus } from '@myco-server-worker/api/status.js';
import { issueMemberToken, NO_RUNTIME_CLAIMS } from '@myco-server-worker/auth/tokens.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { latestOutcome, runMaintenance } from '@myco-server-worker/core/store-maintenance.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { RUN_SCOPE } from '@myco-server-worker/pipeline.js';
import { blobPost, memberHeaders, RETIRED_BYTE_CEILING, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, asOwnerPost } from './helpers/owner.js';

const status = (token: string, body = '{}', extra: Record<string, string> = {}) =>
  new Request('https://s/members/status', { method: 'POST', headers: { ...memberHeaders(token, extra), 'content-type': 'application/json' }, body });

const measured = (value: number) => ({ state: 'measured' as const, value, unit: 'bytes' as const });
const NOT_MEASURED = 'not measured yet; store maintenance measures it when a check runs';

describe('POST /members/status', () => {
  it('answers the target, the schema check, the bytes this credential stored, the retention window and the Deployment\'s storage, and nothing else', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
    const mine = new TextEncoder().encode('bytes this credential stored');
    const theirs = new TextEncoder().encode('bytes another credential stored in another Project');
    expect((await worker.fetch(blobPost(t.token, await sha256HexOf(mine), mine), e.env)).status).toBe(200);
    expect((await worker.fetch(blobPost(other.token, await sha256HexOf(theirs), theirs, 'text/plain; charset=utf-8', { 'x-myco-project': 'proj_2' }), e.env)).status).toBe(200);
    e.sqlite.query(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at) VALUES ('res_live', 'proj_1', 'k', ?, 1000, ?)`).run(t.tokenId, Date.now() + 600_000);
    const charged = (e.sqlite.query('SELECT bytes_written FROM member_credentials WHERE id = ?').get(t.tokenId) as { bytes_written: number }).bytes_written;
    const blobTotal = (e.sqlite.query('SELECT SUM(size) AS n FROM blobs').get() as { n: number }).n;
    expect(charged).toBe(mine.byteLength);

    const before = await worker.fetch(status(t.token), e.env);
    expect(before.status).toBe(200);
    expect(await jsonBody(before)).toEqual({
      persisted: true,
      target: e.serverEnv.platform.name,
      schema: { expected: SERVER_SCHEMA_VERSION, found: SERVER_SCHEMA_VERSION, matches: true },
      stored: measured(charged),
      retention: { transcripts: { state: 'forever', configured: false } },
      storage: [
        { name: 'blob_bytes', state: 'unavailable', reason: NOT_MEASURED, measuredAt: null },
        { name: 'size', state: 'unavailable', reason: NOT_MEASURED, measuredAt: null },
      ],
    });

    const ran = await runMaintenance(e.serverEnv, 'optimize', 'owner', Date.now());
    expect(ran.outcome).toBe('ran');
    const recorded = (await latestOutcome(e.serverEnv, 'optimize'))!;
    expect(recorded.measurements.find((m) => m.name === 'blob_bytes')).toEqual({ name: 'blob_bytes', ...measured(blobTotal) });
    const later = new TextEncoder().encode('bytes stored after the check measured');
    expect((await worker.fetch(blobPost(t.token, await sha256HexOf(later), later), e.env)).status).toBe(200);

    const after = await jsonBody<{ storage: Array<{ name: string }> }>(await worker.fetch(status(t.token), e.env));
    const dated = recorded.measurements.map((m) => ({ ...m, measuredAt: recorded.finishedAt }));
    expect(after.storage).toEqual([
      dated.find((m) => m.name === 'blob_bytes')!, dated.find((m) => m.name === 'size')!,
      ...dated.filter((m) => m.name !== 'blob_bytes' && m.name !== 'size'),
    ]);
    expect(after.storage.map((m) => m.name)).toEqual(['blob_bytes', 'size', 'size_limit', 'daily_quota']);
  });

  it('reports a stored count past the retired 1 GiB ceiling as information, and the retention window as set (#1416)', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    e.sqlite.query('UPDATE member_credentials SET bytes_written = ? WHERE id = ?').run(RETIRED_BYTE_CEILING + 5, t.tokenId);
    const read = async () => jsonBody<{ stored: unknown; retention: unknown }>(await worker.fetch(status(t.token), e.env));
    expect((await read()).stored).toEqual(measured(RETIRED_BYTE_CEILING + 5));
    const writer = settingsWriter(e.serverEnv.db);
    await writer.setLeaf('retention.transcripts', 90, 'mem_machine_1', Date.now());
    expect((await read()).retention).toEqual({ transcripts: { state: 'days', days: 90, configured: true } });
    await writer.setLeaf('retention.transcripts', 0, 'mem_machine_1', Date.now());
    expect((await read()).retention).toEqual({ transcripts: { state: 'forever', configured: true } });
    e.sqlite.query(`UPDATE deployment_settings SET value = 'not json' WHERE leaf = 'retention.transcripts'`).run();
    expect((await read()).retention).toEqual({ transcripts: { state: 'unavailable', reason: 'the stored window does not read; nothing is pruned until it is set again' } });
  });

  it('names blob bytes and the database size unavailable on a target with no store maintenance', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const answer = await handleMemberStatus({ ...e.serverEnv, storeMaintenance: undefined }, {
      memberId: 'mem_machine_1', machineId: 'machine_1', tokenId: t.tokenId, expiresAt: t.expiresAt,
      lineageRoot: t.tokenId, lineageStartedAt: Date.now(), runtime: NO_RUNTIME_CLAIMS, body: '{}', now: Date.now(),
    });
    const reason = 'this target has no store maintenance to measure it';
    expect((await jsonBody<{ storage: unknown }>(answer)).storage).toEqual([
      { name: 'blob_bytes', state: 'unavailable', reason, measuredAt: null },
      { name: 'size', state: 'unavailable', reason, measuredAt: null },
    ]);
  });

  it('refuses a body that is not the empty object, a run\'s credential and a grant, and creates no Project whatever the request names', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const projects = e.sqlite.query('SELECT project_id FROM projects ORDER BY project_id').all();

    expect(await jsonBody(await worker.fetch(status(t.token, JSON.stringify({ project: 'proj_2' })), env))).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field project' });
    expect(await jsonBody(await worker.fetch(status(t.token, 'not json'), env))).toEqual({ persisted: false, code: 'parse', reason: 'body must be JSON' });

    await ensureMember(e.db, HARNESS_MEMBER_ID, Date.now(), 'member', 'harness runtime');
    const harness = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
    expect(await jsonBody(await worker.fetch(status(harness.token), env))).toEqual({ persisted: false, code: 'run_scope', reason: RUN_SCOPE });

    const minted = await worker.fetch(await asOwnerPost('/api/projects/proj_1/grants', { label: 'status reader' }), env);
    const { key } = await minted.json() as { key: string };
    const asGrant = await worker.fetch(new Request('https://s/members/status', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json' }, body: '{}' }), env);
    expect(asGrant.status).toBe(401);

    const unseen = await worker.fetch(status(t.token, '{}', { 'x-myco-project': 'proj_never_seen' }), env);
    expect(((await unseen.json()) as { persisted: boolean }).persisted).toBe(true);
    expect(e.sqlite.query('SELECT project_id FROM projects ORDER BY project_id').all()).toEqual(projects);
  });
});
