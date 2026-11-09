import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const GRACE_PASSED_MS = 30 * 60 * 1000;
const QUARANTINE_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A database never releases what landed in its store before it claimed that store, on both targets, through the
 * product's own entry and clock. An upload whose row is gone stands for an object this database never claimed; one that
 * lands after the claim is the control that shows the walk really ran, and it waits out its quarantine in the journal.
 */
export const objectStoreOwnership: ParityScenario = {
  name: 'object store ownership: a fresh database over a populated store releases and deletes nothing',
  dedicated: { timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const upload = async (text: string): Promise<{ key: string; generation: string; size: number; token: string }> => {
      const bytes = new TextEncoder().encode(text);
      const key = await sha256Hex(bytes);
      const res = await fetch(`${target.url}/blobs/${key}`, { method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }, body: bytes });
      await expectPersisted(res, `blob ${text}`);
      const [row] = await target.sql(`SELECT generation, token_id FROM blobs WHERE project_id = ${lit(target.projectId)} AND key = ${lit(key)}`);
      return { key, generation: String(row!.generation), size: bytes.byteLength, token: String(row!.token_id) };
    };
    const physicalOf = (blob: { key: string; generation: string }) => `${target.projectId}/${blob.key}~${blob.generation}`;
    /** Leaves the bytes in the store with no row naming them, as a database that never claimed them would see. */
    const forget = async (blob: { key: string; generation: string }) => {
      const physical = physicalOf(blob);
      await target.sql(`INSERT INTO object_releases (physical, kind, created_at) VALUES (${lit(physical)}, 'upload', ${stamp})`);
      await target.sql(`DELETE FROM blobs WHERE project_id = ${lit(target.projectId)} AND key = ${lit(blob.key)}`);
      await target.sql(`DELETE FROM object_releases WHERE physical = ${lit(physical)}`);
    };
    const journal = async (blob: { key: string; generation: string }) =>
      await target.sql(`SELECT created_at FROM object_releases WHERE physical = ${lit(physicalOf(blob))}`) as Array<{ created_at: number }>;
    const read = async (key: string) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/blobs/${key}`, { headers: target.ownerHeaders() });
      return { status: res.status, text: await res.text() };
    };
    // A self-hosted wake can be dated past the upload grace. A hosted wake runs at the time it fires, so there the
    // grace is still running and the control below cannot be journaled.
    const dated = target.name === 'selfhosted';
    const wake = (at: number) => dated ? target.clockWake(at) : target.clockWake();

    const old = await upload(`claimed by nobody ${stamp}`);
    await forget(old);
    await Bun.sleep(50);
    const claimed = Date.now();
    await target.sql(`UPDATE object_store_reconciliation SET armed_at = ${claimed}, after_key = '', next_pass_at = 0 WHERE slot = 1`);
    await Bun.sleep(50);

    // A capture after the claim: one row and one fresh object, held by a session.
    const fresh = await upload(`captured after the claim ${stamp}`);
    const session = `parity-ownership-${stamp}`;
    for (const [kind, payload] of [['session.start', { agent: 'claude-code', startedAt: stamp }],
      ['attachment', { attachmentId: crypto.randomUUID(), blob: fresh.key, description: 'fresh' }]] as const) {
      const res = await fetch(`${target.url}/events`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }) });
      await expectPersisted(res, kind);
    }
    const control = await upload(`landed after the claim with no owner ${stamp}`);
    await forget(control);

    const [before] = await target.sql('SELECT revision FROM object_store_reconciliation WHERE slot = 1');
    const first = stamp + GRACE_PASSED_MS;
    for (let pass = 0; pass < 8; pass += 1) {
      await target.sql(`UPDATE object_store_reconciliation SET after_key = '', next_pass_at = 0 WHERE slot = 1`);
      await wake(first + pass * HOUR_MS);
    }
    const [after] = await target.sql('SELECT revision FROM object_store_reconciliation WHERE slot = 1');
    expect(Number(after!.revision)).toBeGreaterThan(Number(before!.revision));

    expect(await journal(old)).toEqual([]);
    if (dated) expect(await journal(control)).toEqual([{ created_at: first + QUARANTINE_MS }]);
    expect(await read(fresh.key)).toEqual({ status: 200, text: `captured after the claim ${stamp}` });

    // The bytes the database never claimed are still there: naming them again reads them back.
    await target.sql(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
      VALUES (${lit(target.projectId)}, ${lit(old.key)}, ${old.size}, 'text/plain; charset=utf-8', ${lit(old.token)}, ${stamp}, ${lit(old.generation)})`);
    expect(await read(old.key)).toEqual({ status: 200, text: `claimed by nobody ${stamp}` });
  },
};
