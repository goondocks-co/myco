import { describe, it, expect } from 'bun:test';
import { sha256Hex } from '../../packages/myco-server/worker/src/hash.js';

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
