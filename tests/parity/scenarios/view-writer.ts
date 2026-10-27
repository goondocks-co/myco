import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, SESSION_SECRET, type ParityScenario } from '../harness.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { selectOwner } from './backup-restore.js';

export const viewWriter: ParityScenario = {
  name: 'view writer: dormant driver parses, rebuilds and publishes through both local front doors',
  dedicated: {
    viewWriter: true,
    cloudflare: { main: '../../tests/parity/view-writer/worker-entry.ts' },
    timeoutMs: 120000,
  },
  async run(target) {
    await selectOwner(target);
    const session = 'writer-' + crypto.randomUUID(),
      transcript = 'tx_' + crypto.randomUUID().replaceAll('-', ''),
      now = Date.now();
    await expectPersisted(
      await fetch(target.url + '/events', {
        method: 'POST',
        headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          eventId: crypto.randomUUID(),
          sessionId: session,
          kind: 'session.start',
          payload: { agent: 'cursor', startedAt: now },
          createdAt: now,
          channel: 'cli',
          producer: { adapter: 'parity', version: '1' },
        }),
      }),
      'start',
    );
    const drive = async (op: string) => {
      const response = await fetch(target.url + '/__view-writer', {
        method: 'POST',
        headers: { ...target.ownerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ op, projectId: target.projectId, sessionId: session }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ instance?: string; published?: number }>;
    };
    const empty = await drive('empty');
    const source = JSON.stringify({ role: 'user', message: { content: 'writer parity prompt' } }) + '\n';
    const bytes = new TextEncoder().encode(source),
      digest = await sha256HexOf(bytes);
    await expectPersisted(
      await fetch(target.url + '/blobs/' + digest, {
        method: 'POST',
        headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.length) }),
        body: bytes,
      }),
      'blob',
    );
    await expectPersisted(
      await fetch(target.url + '/events', {
        method: 'POST',
        headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          eventId: crypto.randomUUID(),
          sessionId: session,
          kind: 'transcript.segment',
          createdAt: now,
          channel: 'cli',
          producer: { adapter: 'cursor', version: '1' },
          payload: { transcriptId: transcript, agent: 'cursor', baseOffset: 0, length: bytes.length, blob: digest },
        }),
      }),
      'transcript',
    );
    const build = await drive('rebuild');
    expect(build.instance).not.toBe(empty.instance);
    let published = 0;
    for (let i = 0; i < 8 && !published; i++) published += (await drive('run')).published ?? 0;
    expect(published).toBe(1);
    const rows = await target.sql(
      `SELECT text,material_seq FROM view_prompts WHERE project_id=${lit(target.projectId)} AND instance_id=${lit(build.instance!)}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('writer parity prompt');
    expect(Number(rows[0].material_seq)).toBeGreaterThan(0);
    expect(
      await target.sql(
        `SELECT live_instance,building_instance FROM session_views WHERE project_id=${lit(target.projectId)} AND session_id=${lit(session)}`,
      ),
    ).toEqual([{ live_instance: build.instance, building_instance: null }]);
    const preflight = `${target.url}/api/status?viewPreflight&project=${encodeURIComponent(target.projectId)}`;
    const ownerPage = await fetch(preflight, { headers: target.ownerHeaders() });
    expect(ownerPage.status).toBe(200);
    const page = (await ownerPage.json()) as { preflight: { project: string; nextCursor: string | null } };
    expect(page.preflight.project).toBe(target.projectId);
    expect(typeof page.preflight.nextCursor).toBe('string');
    await target.sql(
      `INSERT INTO members(id,label,github_id,role,created_at) VALUES('preflight-admin','Preflight admin','7710293','admin',${now})`,
    );
    const cookie = await signSession(SESSION_SECRET, {
      aud: target.deploymentId,
      sub: '7710293',
      login: 'preflight-admin',
      iat: now,
      exp: now + 60000,
    });
    const denied = await fetch(preflight, {
      headers: { ...target.ownerHeaders(), cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(denied.status).toBe(403);
  },
};
