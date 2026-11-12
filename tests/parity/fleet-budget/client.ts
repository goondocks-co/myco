import { expect } from 'bun:test';
import type { ParityTarget } from '../harness.ts';
import { client, joinMember, lapse } from '../clients/identity.ts';

/** One offline machine renews its credential lineage; its member and machine claim stay fixed. */
export async function credentialHistory(target: ParityTarget): Promise<(count: number) => Promise<void>> {
  let { token, tokenId } = await joinMember(target);
  return async (count) => {
    for (let i = 0; i < count; i++) {
      await lapse(target, tokenId);
      const renewed = await client(target, '/tokens/refresh', {}, token);
      expect({ status: renewed.status, refreshed: renewed.body.refreshed, code: renewed.body.code }).toEqual({ status: 200, refreshed: true, code: undefined });
      expect(typeof renewed.body.token).toBe('string');
      expect(typeof renewed.body.tokenId).toBe('string');
      ({ token, tokenId } = renewed.body);
    }
  };
}
