/**
 * What a session reports it created, through `myco_outcomes` and the session page's read.
 *
 * Every session here is started by the capture route and every report lands through the tool or its one writer. A
 * report is admitted only against the caller's own live session, is minted once, and is never rewritten; the page
 * read serves the same rows a page at a time and links only the hosts it names.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { issueExternalGrant } from '@myco-server-worker/auth/grants.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { ARTIFACT_ID_REASON, ARTIFACT_URL_REASON, reportSessionArtifact } from '@myco-server-worker/core/session-artifacts.js';
import { RelationalSnapshotError } from '@myco-server-worker/core/relational-snapshot.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { ARTIFACT_CONFLICT_REASON } from '@myco-server-worker/mcp/tools/outcomes.js';
import { envelope, memberHeaders, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';

const P = 'proj_1';
const PR = 'https://github.com/goondocks-co/myco/pull/1931';
const REFUSED = { ok: false, error: 'session_id not found' };

const rpc = (name: string, args: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

async function rig() {
  const e = sqliteEnv();
  const now = Date.now();
  const t1 = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const t2 = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now);
  let event = 100;
  /** A session as the capture route starts it, under the token's machine. */
  const start = async (token: string, sessionId: string, projectId = P) => {
    const res = await worker.fetch(memberPost(token, envelope({
      eventId: uuid(event++), sessionId, kind: 'session.start', createdAt: 1_000, payload: { agent: 'claude-code', startedAt: 1_000 },
    }), '/events', { [PROJECT_HEADER]: projectId }), e.env);
    expect({ sessionId, persisted: ((await res.json()) as { persisted?: boolean }).persisted }).toEqual({ sessionId, persisted: true });
  };
  const call = async (token: string, args: Record<string, unknown>) => {
    const res = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token), body: rpc('myco_outcomes', { project: P, ...args }) }), e.env);
    const body = await res.json() as { result?: { structuredContent?: { result?: any } }; error?: any };
    return body.result?.structuredContent?.result ?? { rpcError: body.error };
  };
  const report = (token: string, over: Record<string, unknown> = {}) =>
    call(token, { op: 'report', session_id: 's_mine', kind: 'pr', artifact_id: '1931', url: PR, ...over });
  const page = async (sessionId: string, query = '') => {
    const res = await worker.fetch(await asOwner(e.db, `/api/projects/${P}/sessions/${sessionId}/artifacts${query}`), { ...e.env, ...OWNER_ENV });
    return { status: res.status, body: await res.json() as any };
  };
  const rows = () => e.sqlite.query('SELECT session_id, kind, artifact_id, url FROM session_artifacts ORDER BY reported_at, id').all();
  return { ...e, now, t1, t2, start, call, report, page, rows };
}

describe('myco_outcomes report', () => {
  it('records an artifact once, answers the same report again unchanged, and refuses the same artifact under another url', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    const first = await r.report(r.t1.token);
    expect(first).toEqual({ id: expect.any(String), kind: 'pr', artifact_id: '1931', url: PR, linked: true, reported_at: expect.any(Number), session_id: 's_mine', created: true });
    expect(await r.report(r.t1.token)).toEqual({ ...first, created: false });
    expect(await r.report(r.t1.token, { url: 'https://github.com/goondocks-co/myco/pull/1932' })).toEqual({ ok: false, error: ARTIFACT_CONFLICT_REASON });
    expect(r.rows()).toEqual([{ session_id: 's_mine', kind: 'pr', artifact_id: '1931', url: PR }]);
    expect(r.sqlite.query('SELECT author FROM session_artifacts').get()).toEqual({ author: 'mem_machine_1' });

    // The same id under another kind is another artifact.
    expect((await r.report(r.t1.token, { kind: 'issue' })).created).toBe(true);
    expect(r.rows()).toHaveLength(2);
  });

  it('refuses a session the caller may not name — another machine\'s, another Project\'s, a deleted one or an unknown one — and stores nothing', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    await r.start(r.t2.token, 's_theirs');
    await r.start(r.t1.token, 's_elsewhere', 'proj_2');
    await r.start(r.t1.token, 's_deleted');
    await tombstoneSession({ db: r.db }, { projectId: P }, 's_deleted', 'test', r.now);
    for (const session_id of ['s_theirs', 's_elsewhere', 's_deleted', 's_never']) {
      expect({ session_id, answer: await r.report(r.t1.token, { session_id }) }).toEqual({ session_id, answer: REFUSED });
    }
    expect(await r.report(r.t1.token, { session_id: undefined })).toEqual({ ok: false, error: 'session_id is required for op: report' });
    expect(await r.call(r.t1.token, { op: 'list', session_id: 's_elsewhere' })).toEqual(REFUSED);
    expect(r.rows()).toEqual([]);
  });

  it('refuses a url that is not https, carries credentials or is malformed, and an artifact id that is blank or too long, storing nothing', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    for (const url of ['http://github.com/o/r/pull/1', 'javascript:alert(1)', 'https://user:secret@github.com/o/r/pull/1', 'not a url', `https://example.com/${'a'.repeat(2048)}`]) {
      expect({ url: url.slice(0, 40), answer: await r.report(r.t1.token, { url }) }).toEqual({ url: url.slice(0, 40), answer: { ok: false, error: ARTIFACT_URL_REASON } });
    }
    for (const artifact_id of ['  ', 'a'.repeat(257), 'v1\n2']) {
      expect({ artifact_id: artifact_id.slice(0, 10), answer: await r.report(r.t1.token, { artifact_id }) }).toEqual({ artifact_id: artifact_id.slice(0, 10), answer: { ok: false, error: ARTIFACT_ID_REASON } });
    }
    expect((await r.report(r.t1.token, { kind: 'commit' })).rpcError.data.code).toBe('invalid_input');
    expect(r.rows()).toEqual([]);
  });

  it('is offered to a member and to no External Agent grant', async () => {
    const r = await rig();
    const grant = await issueExternalGrant(r.db, { projectId: P }, 'review bot', 'mem_machine_1', r.now);
    const res = await worker.fetch(new Request('https://s/mcp', {
      method: 'POST', headers: { authorization: `Bearer ${grant.key}`, 'cf-connecting-ip': '1.2.3.4' },
      body: rpc('myco_outcomes', { op: 'report', session_id: 's_mine', kind: 'pr', artifact_id: '1', url: PR }),
    }), r.env);
    expect(((await res.json()) as any).error.data.code).toBe('unknown_tool');
    expect(r.rows()).toEqual([]);
  });
});

describe('a session\'s reported artifacts', () => {
  it('writes nothing for a session deleted after admission, and goes with its session when that is deleted', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    await r.start(r.t1.token, 's_gone');
    await tombstoneSession({ db: r.db }, { projectId: P }, 's_gone', 'test', r.now);
    expect(await reportSessionArtifact(r.db, { projectId: P }, { sessionId: 's_gone', kind: 'tag', artifactId: 'v1', url: 'https://github.com/o/r/releases/tag/v1', author: 'mem_machine_1', reportedAt: 1 }))
      .toEqual({ outcome: 'no_session' });
    expect((await r.report(r.t1.token)).created).toBe(true);
    await tombstoneSession({ db: r.db }, { projectId: P }, 's_mine', 'test', r.now);
    expect(r.rows()).toEqual([]);
    expect((await r.page('s_mine')).status).toBe(404);
  });

  it('serves the page oldest first, a page at a time across equal times, linking github.com alone, and MCP lists the same rows', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    const at = (kind: 'pr' | 'deploy' | 'release', artifactId: string, url: string, reportedAt: number) =>
      reportSessionArtifact(r.db, { projectId: P }, { sessionId: 's_mine', kind, artifactId, url, author: 'mem_machine_1', reportedAt });
    await at('deploy', 'dep_1', 'https://myco.example.workers.dev/', 5);
    await at('pr', '7', 'https://github.com/o/r/pull/7', 5);
    await at('release', 'v1.0.0', 'https://github.com/o/r/releases/tag/v1.0.0', 5);
    await at('pr', '8', 'https://www.github.com.evil.example/o/r/pull/8', 9);

    const seen: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const got = await r.page('s_mine', `?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(got.status).toBe(200);
      seen.push(...got.body.rows);
      cursor = got.body.cursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(2);
    expect(seen.map((row) => row.reportedAt)).toEqual([5, 5, 5, 9]);
    expect(seen.slice(0, 3).map((row) => row.id)).toEqual(seen.slice(0, 3).map((row) => row.id).sort());
    expect(Object.fromEntries(seen.map((row) => [row.artifactId, row.linked]))).toEqual({ dep_1: false, 7: true, 'v1.0.0': true, 8: false });
    expect(Object.keys(seen[0]).sort()).toEqual(['artifactId', 'id', 'kind', 'linked', 'reportedAt', 'url']);

    const listed = await r.call(r.t1.token, { op: 'list', session_id: 's_mine' });
    expect(listed.artifacts.map((row: any) => row.id)).toEqual(seen.map((row) => row.id));
    expect(listed.cursor).toBeNull();

    expect((await r.page('s_never')).status).toBe(404);
    expect((await r.page('s_mine', '?cursor=nonsense')).status).toBe(400);
  });

  it('links github.com only at the default https port, through the report and the page read alike', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    const ported = await r.report(r.t1.token, { artifact_id: '9', url: 'https://github.com:444/o/r/pull/9' });
    expect({ created: ported.created, url: ported.url, linked: ported.linked }).toEqual({ created: true, url: 'https://github.com:444/o/r/pull/9', linked: false });
    const plain = await r.report(r.t1.token, { artifact_id: '10', url: 'https://github.com:443/o/r/pull/10' });
    expect({ url: plain.url, linked: plain.linked }).toEqual({ url: 'https://github.com/o/r/pull/10', linked: true });
    const page = await r.page('s_mine');
    expect(page.body.rows.map((row: any) => [row.artifactId, row.linked])).toEqual(expect.arrayContaining([['9', false], ['10', true]]));
  });

  it('admits every report at the writer itself: a credential-bearing or malformed artifact is refused there, and a URL is stored serialized', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    const write = (over: Record<string, unknown>) => reportSessionArtifact(r.db, { projectId: P }, {
      sessionId: 's_mine', kind: 'pr', artifactId: '1', url: 'https://github.com/o/r/pull/1', author: 'mem_machine_1', reportedAt: 1, ...over,
    });
    expect(await write({ url: 'https://user:secret@github.com/o/r/pull/1' })).toEqual({ outcome: 'refused', reason: ARTIFACT_URL_REASON });
    expect(await write({ url: 'http://github.com/o/r/pull/1' })).toEqual({ outcome: 'refused', reason: ARTIFACT_URL_REASON });
    expect(await write({ artifactId: ' ' })).toEqual({ outcome: 'refused', reason: ARTIFACT_ID_REASON });
    expect((await write({ kind: 'commit' })).outcome).toBe('refused');
    expect(r.rows()).toEqual([]);
    const created = await write({ url: 'https://GitHub.com/o/r/pull/1' });
    expect(created.outcome === 'created' && created.artifact.url).toBe('https://github.com/o/r/pull/1');
    expect((await write({ url: 'https://github.com/o/r/pull/1' })).outcome).toBe('existing');
  });

  it('restores reports for live sessions and none for a session the destination deleted', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    await r.start(r.t1.token, 's_other');
    expect((await r.report(r.t1.token)).created).toBe(true);
    expect((await r.report(r.t1.token, { session_id: 's_other' })).created).toBe(true);
    const backup = await createBackup(r.db, r.serverEnv.blobs, { producer: 'test', now: r.now });
    const { text } = (await backupArtifact(r.db, r.serverEnv.blobs, backup.id))!;

    const restored = sqliteEnv();
    const blobs = serverEnvFromBindings(restored.env).blobs;
    restored.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, 'p', 1) ON CONFLICT DO NOTHING`, [P]);
    restored.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, created_at, created_by) VALUES (?, 's_other', 1, 'owner')`, [P]);
    for (let pass = 0; pass < 2; pass++) {
      await restoreArtifact(restored.db, { text, blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
      expect(restored.sqlite.query('SELECT session_id, kind, artifact_id, url FROM session_artifacts').all())
        .toEqual([{ session_id: 's_mine', kind: 'pr', artifact_id: '1931', url: PR }]);
    }
  });

  it('refuses a restore whose stored artifact fails admission or names a session nobody holds, writing nothing, and restores one whose session the destination holds', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    expect((await r.report(r.t1.token)).created).toBe(true);
    const backup = await createBackup(r.db, r.serverEnv.blobs, { producer: 'test', now: r.now });
    const { text } = (await backupArtifact(r.db, r.serverEnv.blobs, backup.id))!;
    const altered = (change: (line: { t: string; r: Record<string, unknown> }) => { t: string; r: Record<string, unknown> } | null) => text.split('\n').map((line, i) => {
      if (i === 0 || line.length === 0) return line;
      const changed = change(JSON.parse(line));
      return changed === null ? null : JSON.stringify(changed);
    }).filter((line) => line !== null).join('\n');
    const artifactRow = (patch: Record<string, unknown>) => altered((line) => (line.t === 'session_artifacts' ? { ...line, r: { ...line.r, ...patch } } : line));
    const fresh = () => {
      const target = sqliteEnv();
      target.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, 'p', 1) ON CONFLICT DO NOTHING`, [P]);
      return target;
    };
    const restore = (target: ReturnType<typeof sqliteEnv>, body: string) =>
      restoreArtifact(target.db, { text: body, blobs: serverEnvFromBindings(target.env).blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    const stored = (target: ReturnType<typeof sqliteEnv>) => target.sqlite.query('SELECT session_id, url FROM session_artifacts').all();

    for (const [label, patch] of [
      ['credentials', { url: 'https://user:secret@github.com/goondocks-co/myco/pull/1931' }],
      ['not serialized', { url: 'https://GitHub.com/goondocks-co/myco/pull/1931' }],
      ['orphan', { session_id: 's_never_present' }],
    ] as const) {
      const target = fresh();
      const refused = await restore(target, artifactRow(patch)).then(() => null, (error: Error) => error);
      expect({ label, name: refused?.name, table: (refused as { table?: string } | null)?.table }).toEqual({ label, name: 'BackupApplyError', table: 'session_artifacts' });
      expect({ label, rows: stored(target), sessions: target.sqlite.query('SELECT COUNT(*) AS n FROM sessions').get() }).toEqual({ label, rows: [], sessions: { n: 0 } });
    }

    const target = fresh();
    await restore(target, text);
    const withoutSessions = altered((line) => (line.t === 'sessions' ? null : line));
    await restore(target, withoutSessions);
    expect(stored(target)).toEqual([{ session_id: 's_mine', url: PR }]);
  });

  it('refuses to publish a backup whose artifact names a session the snapshot does not carry', async () => {
    const r = await rig();
    await r.start(r.t1.token, 's_mine');
    expect((await r.report(r.t1.token)).created).toBe(true);
    r.sqlite.run(`UPDATE session_artifacts SET session_id = 's_never_present'`);
    const refused = await createBackup(r.db, r.serverEnv.blobs, { producer: 'test', now: r.now }).then(() => null, (error: Error) => error);
    expect(refused).toBeInstanceOf(RelationalSnapshotError);
    expect(refused!.message).toContain('session_artifacts names a missing session');
  });
});
