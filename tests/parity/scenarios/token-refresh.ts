import { expect } from 'bun:test';
import { MEMBER_LINEAGE_IDLE_MS, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { ageRows, expectPersisted, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { credentials, joinMember, lapse, stopMember } from '../clients/identity.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A member offline past its token's expiry on both targets: the lapsed token
 * still rotates while its lineage refreshed within the inactivity bound, over a
 * request that names no Project; the successor captures; a replay of the lapsed
 * token once its successor is in use answers 401 on a capture route and
 * revokes nothing, and asking to rotate it revokes the whole lineage and says
 * why. A lineage that started long before the bound but kept refreshing
 * rotates, its successor one TTL from now; a lapsed token whose lineage has
 * been silent for the bound is told `lineage_expired` with nothing minted.
 */
export const tokenRefresh: ParityScenario = {
  name: 'token refresh: a token lapsed offline rotates once within its lineage, a superseded one asking to rotate revokes it, a lineage never ends for age, and one silent past the inactivity bound is refused by name',
  async run(target: ParityTarget) {
    const now = Date.now();
    /** The member's own refresh: the credential is the Deployment's, so the request names no Project. */
    const refresh = (token: string) => {
      const { [PROJECT_HEADER]: _project, ...headers } = memberHeadersFor(token, target.projectId);
      return fetch(`${target.url}/tokens/refresh`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
    };
    const post = (token: string) => fetch(`${target.url}/events`, {
      method: 'POST',
      headers: { ...memberHeadersFor(token, target.projectId), 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: crypto.randomUUID(), sessionId: `parity-refresh-${crypto.randomUUID()}`, kind: 'session.start', createdAt: Date.now(), channel: 'cli',
        producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: now },
      }),
    });
    const lineageOf = async (root: string) => (await credentials(target)).filter((row) => row.lineageRoot === root);
    const liveOf = async (root: string) => (await lineageOf(root)).filter((row) => row.revokedAt === null).length;
    const rowOf = async (id: string) => (await credentials(target)).find((row) => row.id === id);
    const joined: string[] = [];
    const lapsedMember = async () => {
      const member = await joinMember(target);
      joined.push(member.id);
      await lapse(target, member.tokenId);
      return member;
    };
    try {
      const lapsed = await lapsedMember();
      expect((await post(lapsed.token)).status).toBe(401);
      const res = await refresh(lapsed.token);
      const body = (await res.json()) as { refreshed: boolean; token: string; tokenId: string; expiresAt: number };
      expect({ status: res.status, refreshed: body.refreshed }).toEqual({ status: 200, refreshed: true });
      expect(body.expiresAt).toBeGreaterThan(now);
      expect(await rowOf(body.tokenId)).toMatchObject({ predecessorId: lapsed.tokenId, lineageRoot: lapsed.tokenId });
      await expectPersisted(await post(body.token), 'successor capture');
      // The superseded token on a capture route is refused and revokes nothing: a stale holder re-reads its registry.
      const stale = await post(lapsed.token);
      expect({ status: stale.status, body: await stale.json() }).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(await liveOf(lapsed.tokenId)).toBe(1);
      // Asking to rotate it means a second holder rotated the lineage: every live row of it is revoked, and the answer says why.
      const replayed = await refresh(lapsed.token);
      expect({ status: replayed.status, protocol: replayed.headers.get('x-myco-protocol'), body: await replayed.json() })
        .toEqual({ status: 401, protocol: null, body: { error: 'unauthorized', code: 'lineage_replayed' } });
      expect({ rows: (await lineageOf(lapsed.tokenId)).length, live: await liveOf(lapsed.tokenId) }).toEqual({ rows: 2, live: 0 });
      expect((await rowOf(body.tokenId))?.revokedBy).toBe('lineage-replay');
      const cutOff = await post(body.token);
      expect({ status: cutOff.status, body: await cutOff.json() }).toEqual({ status: 401, body: { error: 'unauthorized', code: 'lineage_replayed' } });

      // A lineage that started long before the bound and kept refreshing rotates again once its current token lapses.
      const longLived = await lapsedMember();
      const first = (await (await refresh(longLived.token)).json()) as { token: string; tokenId: string };
      await expectPersisted(await post(first.token), 'long-lived lineage first successor');
      await ageRows(target, { table: 'member_credentials', column: 'lineage_started_at', byMs: 2 * MEMBER_LINEAGE_IDLE_MS, match: { lineage_root: longLived.tokenId } });
      const startedAt = (await rowOf(first.tokenId))!.lineageStartedAt;
      await lapse(target, first.tokenId);
      const kept = await refresh(first.token);
      const keptBody = (await kept.json()) as { refreshed: boolean; token: string; tokenId: string; expiresAt: number };
      expect({ status: kept.status, refreshed: keptBody.refreshed }).toEqual({ status: 200, refreshed: true });
      expect(keptBody.expiresAt).toBeGreaterThanOrEqual(now + MEMBER_TOKEN_TTL_MS);
      expect(await rowOf(keptBody.tokenId)).toMatchObject({ predecessorId: first.tokenId, lineageRoot: longLived.tokenId, lineageStartedAt: startedAt });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2 * MEMBER_LINEAGE_IDLE_MS);
      await expectPersisted(await post(keptBody.token), 'long-lived lineage successor capture');

      // A lapsed token whose lineage has been silent for the bound is refused by name, and nothing is minted.
      const ended = await lapsedMember();
      await ageRows(target, { table: 'member_credentials', column: 'issued_at', byMs: MEMBER_LINEAGE_IDLE_MS + DAY_MS, match: { id: ended.tokenId } });
      const refused = await refresh(ended.token);
      expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 200, body: { refreshed: false, code: 'lineage_expired', reason: 'token lineage inactive' } });
      expect((await lineageOf(ended.tokenId)).length).toBe(1);
    } finally {
      for (const id of joined) await stopMember(target, id);
    }
  },
};
