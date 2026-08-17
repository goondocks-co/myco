import { describe, it, expect } from 'bun:test';
import { handleRequest } from '../../packages/myco-server/worker/src/index.js';

describe('health route', () => {
  it('answers 200 with ok:true', async () => {
    const res = await handleRequest(new Request('https://s/health'), {} as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
