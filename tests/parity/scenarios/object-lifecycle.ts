import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The object lifecycle on both targets, through the product's own entry, store and clock:
 * - an upload is stored under its own generation, and its row names it;
 * - a deletion journals the exact stored object; an owner's wake never deletes it, and the target's own clock does;
 * - an expired upload authority is consumed by the clock and its generation journaled and deleted;
 * - a row registered before generations reads its bytes by its legacy name, and is released by that name;
 * - an open recovery hold keeps what a deletion released recorded, and the clock releases it once the hold is released.
 */
export const objectLifecycle: ParityScenario = {
  name: 'object lifecycle: generation names, clock-owned deletion, expired authority, legacy rows, and a recovery hold',
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
      expect(res.status).toBe(200);
      return res.json() as Promise<{ blobsFreed: number; blobsLeft: number }>;
    };
    const attached = async (label: string, key: string) => {
      const session = `parity-lifecycle-${label}-${stamp}`;
      await post(session, 'session.start', { agent: 'claude-code', startedAt: stamp });
      await post(session, 'attachment', { attachmentId: crypto.randomUUID(), blob: key, description: label });
      return session;
    };
    /** The journal rows naming `part`, filtered here: the hosted command line takes no SQL wildcard. */
    const journal = async (part: string) => (await target.sql('SELECT physical FROM object_releases ORDER BY physical'))
      .map((row) => String(row.physical)).filter((physical) => physical.includes(part));
    const ownerWake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { jobs: Array<{ name: string }> };
    };

    // An upload is stored under its own generation.
    const key = await upload(`lifecycle body ${stamp}`);
    const [row] = await target.sql(`SELECT generation FROM blobs WHERE project_id = ${lit(target.projectId)} AND key = ${lit(key)}`);
    expect(String(row!.generation)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await read(key)).toEqual({ status: 200, text: `lifecycle body ${stamp}` });

    // A deletion journals the exact object; an owner's wake leaves it; the clock deletes it.
    const deleted = await attached('deleted', key);
    expect(await tombstone(deleted)).toMatchObject({ blobsFreed: 1, blobsLeft: 0 });
    const physical = `${target.projectId}/${key}~${String(row!.generation)}`;
    expect(await journal(key)).toEqual([physical]);
    expect((await read(key)).status).toBe(404);
    expect((await ownerWake()).jobs.map((job) => job.name)).not.toContain('object-release-drain');
    expect(await journal(key)).toEqual([physical]);
    await target.clockWake();
    expect(await journal(key)).toEqual([]);

    // An expired upload authority is consumed by the clock, and its generation journaled and deleted.
    const abandoned = crypto.randomUUID();
    const [credential] = await target.sql(`SELECT id FROM member_credentials ORDER BY issued_at LIMIT 1`) as Array<{ id: string }>;
    await target.sql(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at)
      VALUES (${lit(abandoned)}, ${lit(target.projectId)}, ${lit('e'.repeat(64))}, ${lit(credential!.id)}, 1, 1)`);
    await target.clockWake();
    expect(await target.sql(`SELECT reservation_id FROM blob_reservations WHERE reservation_id = ${lit(abandoned)}`)).toEqual([]);
    expect(await journal(abandoned)).toEqual([]);

    // A row registered before generations reads by its legacy name and is released by it.
    const legacyText = `legacy body ${stamp}`;
    const legacyBytes = new TextEncoder().encode(legacyText);
    const legacy = await sha256Hex(legacyBytes);
    await target.putObject(`${target.projectId}/${legacy}`, legacyBytes);
    await target.sql(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at)
      VALUES (${lit(target.projectId)}, ${lit(legacy)}, ${legacyBytes.byteLength}, 'text/plain', ${lit(credential!.id)}, ${stamp})`);
    expect(await read(legacy)).toEqual({ status: 200, text: legacyText });
    const legacySession = await attached('legacy', legacy);
    await tombstone(legacySession);
    expect(await journal(legacy)).toEqual([`${target.projectId}/${legacy}`]);
    await target.clockWake();
    expect(await journal(legacy)).toEqual([]);

    // An open hold keeps what a deletion released recorded; the clock releases it once the hold is released.
    const heldKey = await upload(`held body ${stamp}`);
    await target.sql(`INSERT INTO recovery_holds (token, acquired_at) VALUES ('parity-hold-${stamp}', ${stamp})`);
    try {
      const heldSession = await attached('held', heldKey);
      expect(await tombstone(heldSession)).toMatchObject({ blobsFreed: 0, blobsLeft: 1 });
      // The clock is not woken while this hold is open: a hold no attempt carries is retired by the release job on a
      // target whose producer can answer, which is that job's own behaviour and not what this part holds.
      expect(await target.sql(`SELECT key FROM blobs WHERE key = ${lit(heldKey)}`)).toEqual([{ key: heldKey }]);
      expect(await target.sql(`SELECT key FROM blob_release_candidates WHERE key = ${lit(heldKey)}`)).toEqual([{ key: heldKey }]);
    } finally {
      await target.sql(`UPDATE recovery_holds SET released_at = ${Date.now()}, release_reason = 'parity' WHERE token = 'parity-hold-${stamp}'`);
    }
    await target.clockWake();
    await target.clockWake();
    expect(await target.sql(`SELECT key FROM blobs WHERE key = ${lit(heldKey)}`)).toEqual([]);
    expect(await target.sql(`SELECT key FROM blob_release_candidates WHERE key = ${lit(heldKey)}`)).toEqual([]);
    expect(await journal(heldKey)).toEqual([]);
  },
};
