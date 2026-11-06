import { jsonBody } from '../helpers/json-body.js';
import { describe, it, expect } from 'bun:test';
import { handleRequest } from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

describe('health route', () => {
  it('answers 200 with ok:true', async () => {
    const res = await handleRequest(new Request('https://s/health'), {} as any);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ ok: true });
  });

  it('keeps the other Health reads available when the KPI query fails', async () => {
    const e = sqliteEnv({ onSql: sql => {
      if (sql.includes('AS first_served')) throw new Error('D1_ERROR: fixture query failure');
    } });
    try {
      const cookie = await ownerCookie(e.db);
      const paths = ['/api/kpis?window=30', '/api/machines?limit=50', '/api/uncaptured', '/api/maintenance', '/api/embedding/passed-over', '/api/status'];
      const responses = await Promise.all(paths.map(path => handleRequest(new Request(`https://s${path}`, {
        headers: { cookie, 'cf-connecting-ip': '1.2.3.4' },
      }), { ...e.env, ...OWNER_ENV })));
      expect(responses.map(response => response.status)).toEqual([503, 200, 200, 200, 200, 200]);
      expect(await jsonBody(responses[0]!)).toEqual({ error: 'unavailable' });
    } finally { e.sqlite.close(); }
  });
});
