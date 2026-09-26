import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'bun:test';
import { MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { expectPersisted, lit, MACHINE_ID, MEMBER_ID, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/** The lifetime byte ceiling a credential carried before #1416. */
const RETIRED_BYTE_CEILING = 1_073_741_824;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Capture is never refused for volume, on both targets (#1416): a credential
 * whose stored-bytes count stands at and then past the retired 1 GiB lifetime
 * ceiling still stores an event, a blob and a transcript segment, and the count
 * keeps growing as information. A revoked credential admits nothing: every
 * capture route answers 401 and nothing lands.
 */
export const captureVolume: ParityScenario = {
  name: 'capture volume: capture past the retired 1 GiB ceiling is admitted and counted; a revoked credential admits nothing',
  async run(target: ParityTarget) {
    const now = Date.now();
    const token = randomBytes(32).toString('base64url');
    const tokenId = `mt_parity_volume_${randomBytes(6).toString('hex')}`;
    await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at)
      VALUES (${lit(tokenId)}, ${lit(MEMBER_ID)}, ${lit(MACHINE_ID)}, ${lit(sha256(new TextEncoder().encode(token)))}, ${now}, ${now + MEMBER_TOKEN_TTL_MS}, NULL, ${RETIRED_BYTE_CEILING}, NULL, ${lit(tokenId)}, ${now}, NULL)`);
    const counted = async (): Promise<number> => Number((await target.sql(`SELECT bytes_written AS n FROM member_credentials WHERE id = ${lit(tokenId)}`))[0]?.n);
    const headers = (extra: Record<string, string> = {}) => ({ ...memberHeadersFor(token, target.projectId), ...extra });
    const sessionId = `parity-volume-${now}`;
    const event = (kind: string, payload: Record<string, unknown>) => fetch(`${target.url}/events`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
    });
    const blob = (bytes: Uint8Array<ArrayBuffer>) => fetch(`${target.url}/blobs/${sha256(bytes)}`, {
      method: 'POST', headers: headers({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes,
    });

    await expectPersisted(await event('session.start', { agent: 'claude-code', startedAt: now }), 'event at the retired ceiling');
    const afterEvent = await counted();
    expect(afterEvent).toBeGreaterThan(RETIRED_BYTE_CEILING);

    const line = new TextEncoder().encode(`${JSON.stringify({ type: 'user', message: { content: `past the ceiling ${now}` }, timestamp: new Date(now).toISOString() })}\n`);
    await expectPersisted(await blob(line), 'blob past the retired ceiling');
    expect(await counted()).toBe(afterEvent + line.byteLength);
    const transcriptId = `tx_${randomBytes(16).toString('hex')}`;
    await expectPersisted(await event('transcript.segment', { transcriptId, baseOffset: 0, length: line.byteLength, blob: sha256(line), agent: 'claude-code' }), 'transcript segment past the retired ceiling');

    // Far past it: several times the retired ceiling is still information, never a refusal.
    await target.sql(`UPDATE member_credentials SET bytes_written = ${5 * RETIRED_BYTE_CEILING} WHERE id = ${lit(tokenId)}`);
    const more = new TextEncoder().encode(`more bytes ${now}`);
    await expectPersisted(await blob(more), 'blob at five times the retired ceiling');
    expect(await counted()).toBe(5 * RETIRED_BYTE_CEILING + more.byteLength);

    await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE id = ${lit(tokenId)}`);
    const events = Number((await target.sql(`SELECT COUNT(*) AS n FROM events WHERE session_id = ${lit(sessionId)}`))[0]?.n);
    const refused = new TextEncoder().encode(`refused bytes ${now}`);
    expect((await event('prompt', { promptId: crypto.randomUUID(), text: 'after revocation', origin: 'user' })).status).toBe(401);
    expect((await blob(refused)).status).toBe(401);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM events WHERE session_id = ${lit(sessionId)}`)).toEqual([{ n: events }]);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM blobs WHERE key = ${lit(sha256(refused))}`)).toEqual([{ n: 0 }]);
    expect(await counted()).toBe(5 * RETIRED_BYTE_CEILING + more.byteLength);
  },
};
