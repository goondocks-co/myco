import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'bun:test';
import { MEMBER_TOKEN_MAX_LINEAGE_MS, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { expectPersisted, lit, MACHINE_ID, MEMBER_ID, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A member offline past its token's expiry on both targets: the lapsed token
 * still rotates while its lineage is live, over a request that names no
 * Project; the successor captures; a replay of the lapsed token once its
 * successor is in use answers 401; and a lapsed token whose lineage ceiling has
 * passed is told `lineage_expired` with nothing minted.
 */
export const tokenRefresh: ParityScenario = {
  name: 'token refresh: a token lapsed offline rotates once within its lineage, and past the lineage ceiling is refused by name',
  async run(target: ParityTarget) {
    const now = Date.now();
    /** Seeds a root credential of the parity member issued at `issuedAt`, and returns its raw token and id. */
    const seed = async (issuedAt: number) => {
      const token = randomBytes(32).toString('base64url');
      const tokenId = `mt_parity_${randomBytes(6).toString('hex')}`;
      const digest = createHash('sha256').update(token).digest('hex');
      await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at)
        VALUES (${lit(tokenId)}, ${lit(MEMBER_ID)}, ${lit(MACHINE_ID)}, ${lit(digest)}, ${issuedAt}, ${issuedAt + MEMBER_TOKEN_TTL_MS}, NULL, 0, NULL, ${lit(tokenId)}, ${issuedAt}, NULL)`);
      return { token, tokenId };
    };
    /** The member's own refresh: the credential is the Deployment's, so the request names no Project. */
    const refresh = (token: string) => {
      const { [PROJECT_HEADER]: _project, ...headers } = memberHeadersFor(token, target.projectId);
      return fetch(`${target.url}/tokens/refresh`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
    };
    const post = (token: string) => fetch(`${target.url}/events`, {
      method: 'POST',
      headers: { ...memberHeadersFor(token, target.projectId), 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: crypto.randomUUID(), sessionId: `parity-refresh-${now}`, kind: 'session.start', createdAt: Date.now(), channel: 'cli',
        producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: now },
      }),
    });

    const lapsed = await seed(now - 20 * DAY_MS);
    expect((await post(lapsed.token)).status).toBe(401);
    const res = await refresh(lapsed.token);
    const body = (await res.json()) as { refreshed: boolean; token: string; tokenId: string; expiresAt: number };
    expect({ status: res.status, refreshed: body.refreshed }).toEqual({ status: 200, refreshed: true });
    expect(body.expiresAt).toBeGreaterThan(now);
    expect(await target.sql(`SELECT predecessor_id AS predecessor, lineage_root AS root FROM member_credentials WHERE id = ${lit(body.tokenId)}`))
      .toEqual([{ predecessor: lapsed.tokenId, root: lapsed.tokenId }]);
    await expectPersisted(await post(body.token), 'successor capture');
    expect((await refresh(lapsed.token)).status).toBe(401);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM member_credentials WHERE lineage_root = ${lit(lapsed.tokenId)}`)).toEqual([{ n: 2 }]);

    const ended = await seed(now - MEMBER_TOKEN_MAX_LINEAGE_MS - DAY_MS);
    const refused = await refresh(ended.token);
    expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 200, body: { refreshed: false, code: 'lineage_expired', reason: 'token lineage expired' } });
    expect(await target.sql(`SELECT COUNT(*) AS n FROM member_credentials WHERE lineage_root = ${lit(ended.tokenId)}`)).toEqual([{ n: 1 }]);
  },
};
