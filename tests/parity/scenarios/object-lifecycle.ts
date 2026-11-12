import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';
import { expect } from 'bun:test';
import { ageRows, expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const objectLifecycle: ParityScenario = {
  name: 'object lifecycle: generation names and clock-owned physical deletion',
  dedicated: { timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const upload = async (text: string): Promise<string> => {
      const bytes = new TextEncoder().encode(text);
      const key = await sha256Hex(bytes);
      const res = await fetch(`${target.url}/blobs/${key}`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) },
        body: bytes,
      });
      await expectPersisted(res, `blob ${text}`);
      return key;
    };
    const read = async (key: string): Promise<{ status: number; text: string }> => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/blobs/${key}`, { headers: target.ownerHeaders() });
      return { status: res.status, text: await res.text() };
    };
    const tombstone = async (sessionId: string) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${sessionId}/tombstone`, {
        method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(202);
      await res.body?.cancel();
    };
    /** Runs the deletion job through owner wakes until its progress reports it complete. */
    const deleted_ = async (sessionId: string) => {
      for (let wake = 0; wake < 60; wake += 1) {
        const progress = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${sessionId}/deletion`, { headers: target.ownerHeaders() });
        expect(progress.status).toBe(200);
        if (((await progress.json()) as { deletion: { state: string } }).deletion.state === 'complete') return;
        const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
        expect(res.status).toBe(200);
        await res.body?.cancel();
      }
      throw new Error(`deletion of ${sessionId} did not finish`);
    };
    /** Past the upload grace, so a deletion's candidate can decide at once instead of waiting it out. */
    const age = (key: string) => ageRows(target, { table: 'blobs', column: 'received_at', byMs: BLOB_RESERVATION_TTL_MS + 1000, match: { project_id: target.projectId, key } });
    const attached = async (label: string, key: string) => {
      const session = `parity-lifecycle-${label}-${stamp}`;
      await post(session, 'session.start', { agent: 'claude-code', startedAt: stamp });
      await post(session, 'attachment', { attachmentId: crypto.randomUUID(), blob: key, description: label });
      return session;
    };
    // Stored deletion intents name the exact physical generation until the clock acknowledges deletion.
    const journal = async (part: string) => (await target.sql('SELECT physical FROM object_releases ORDER BY physical'))
      .map((row) => String(row.physical)).filter((physical) => physical.includes(part));
    const ownerWake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { jobs: Array<{ name: string }> };
    };

    // The registered generation identifies the physical object a session deletion must release.
    const key = await upload(`lifecycle body ${stamp}`);
    const [row] = await target.sql(`SELECT generation FROM blobs WHERE project_id = ${lit(target.projectId)} AND key = ${lit(key)}`);
    expect(String(row!.generation)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await read(key)).toEqual({ status: 200, text: `lifecycle body ${stamp}` });

    // A deletion journals the exact object; an owner's wake leaves it; the clock deletes it.
    const deleted = await attached('deleted', key);
    await age(key);
    await tombstone(deleted);
    await deleted_(deleted);
    const physical = `${target.projectId}/${key}~${String(row!.generation)}`;
    expect(await journal(key)).toEqual([physical]);
    expect((await read(key)).status).toBe(404);
    expect((await ownerWake()).jobs.map((job) => job.name)).not.toContain('object-release-drain');
    expect(await journal(key)).toEqual([physical]);
    await target.clockWake();
    expect(await journal(key)).toEqual([]);

  },
};
