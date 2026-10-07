import { describe, expect, it, spyOn } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { DEVICE_TTL_MS } from '@myco-server-worker/auth/device.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const NOW = Date.now();
const OWNER = 'mem_machine_1';
const MEMBER = 'mem_machine_2';
const ADMIN = 'mem_machine_3';
const json = async (r: Response): Promise<Record<string, any>> => await r.json() as Record<string, any>;

function rig(onSql?: NonNullable<Parameters<typeof sqliteEnv>[0]>['onSql']) {
  const e = sqliteEnv({ onSql });
  e.sqlite.run(`UPDATE deployment_ownership SET member_id = '${OWNER}', revision = 1 WHERE id = 1`);
  e.sqlite.run(`UPDATE members SET role = 'member', github_id = '770001' WHERE id = '${MEMBER}'`);
  e.sqlite.run(`UPDATE members SET role = 'admin', github_id = '770003' WHERE id = '${ADMIN}'`);
  let now = NOW;
  const server = createServer({ now: () => now, sourceOf: () => '192.0.2.10', fetchImpl: () => { throw new Error('unexpected OAuth'); } });
  const env = { ...e.serverEnv, secrets: OWNER_ENV };
  const post = (path: string, body: unknown, cookie?: string, origin = 'https://s') => server.handleRequest(new Request(`https://s${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }), env);
  const start = async (machineId = `device_${crypto.randomUUID()}`) => json(await post('/auth/device/start', { machineId, machineName: 'Test laptop', os: 'darwin' }));
  const poll = (code: string) => post('/auth/device/poll', { device_code: code }).then(json);
  const decide = async (code: string, decision: 'approve' | 'deny' | 'preview' = 'approve', who = '770001') => post(`/api/device/${decision}`, { user_code: code }, await ownerCookie(now, who));
  const advance = (ms = 5000) => { now += ms; };
  const count = () => (e.sqlite.query('SELECT COUNT(*) AS n FROM member_credentials').get() as { n: number }).n;
  return { e, env, post, start, poll, decide, advance, count };
}

describe('device authorization', () => {
  it('starts digest-only, shows trusted machine/IP/scope, approves self, and redeems once through join', async () => {
    const r = rig();
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation(value => { logs.push(String(value)); });
    try {
      const before = r.count();
      const start = await r.start('new_device');
      expect(start).toMatchObject({ interval: 5, expires_in: 600, verification_uri: 'https://s/device' });
      expect(start.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const stored = r.e.sqlite.query('SELECT * FROM device_requests').all();
      expect(JSON.stringify(stored)).not.toContain(start.device_code);
      expect(JSON.stringify(stored)).not.toContain(start.user_code);
      expect(await r.poll(start.device_code)).toEqual({ error: 'authorization_pending' });
      expect(await json(await r.decide(start.user_code, 'preview'))).toMatchObject({ machineName: 'Test laptop', os: 'darwin', ip: '192.0.2.10', scope: 'membership' });
      expect(await json(await r.decide(start.user_code))).toEqual({ approved: true });
      r.advance();
      const joined = await r.poll(start.device_code);
      expect(joined).toMatchObject({ joined: true, memberId: MEMBER, role: 'member', projectId: null });
      expect(typeof joined.token).toBe('string');
      expect(r.count()).toBe(before + 1);
      expect(r.e.sqlite.query('SELECT member_id FROM machine_claims WHERE machine_id = ?').get('new_device')).toEqual({ member_id: MEMBER });
      expect(r.e.sqlite.query('SELECT decision, decided_by, decided_at FROM device_requests').get()).toEqual({ decision: 'approved', decided_by: MEMBER, decided_at: NOW });
      expect(await r.poll(start.device_code)).toEqual({ error: 'invalid_grant' });
      expect((await r.decide(start.user_code, 'deny')).status).toBe(409);
      expect((await r.decide(start.user_code)).status).toBe(409);
      expect(r.count()).toBe(before + 1);
      log.mockRestore();
      expect(logs.join('\n')).not.toContain(start.device_code);
      expect(logs.join('\n')).not.toContain(joined.token);
    } finally { log.mockRestore(); r.e.sqlite.close(); }
  });

  it('persists slow_down increments and admits only the new interval', async () => {
    const r = rig();
    try {
      const start = await r.start();
      expect(await r.poll(start.device_code)).toEqual({ error: 'authorization_pending' });
      expect(await r.poll(start.device_code)).toEqual({ error: 'slow_down', interval: 10 });
      r.advance(5000);
      expect(await r.poll(start.device_code)).toEqual({ error: 'slow_down', interval: 15 });
      r.advance(15000);
      expect(await r.poll(start.device_code)).toEqual({ error: 'authorization_pending' });
      expect(await r.poll(start.device_code)).toEqual({ error: 'slow_down', interval: 20 });
    } finally { r.e.sqlite.close(); }
  });

  it('denies and expires without granting a credential', async () => {
    const r = rig();
    try {
      const before = r.count();
      const denied = await r.start();
      expect(await json(await r.decide(denied.user_code, 'deny'))).toEqual({ denied: true });
      expect(await r.poll(denied.device_code)).toEqual({ error: 'access_denied' });
      expect((await r.decide(denied.user_code)).status).toBe(409);
      const expired = await r.start();
      r.advance(DEVICE_TTL_MS);
      expect(await r.poll(expired.device_code)).toEqual({ error: 'expired_token' });
      expect((await r.decide(expired.user_code)).status).toBe(409);
      expect(r.count()).toBe(before);
    } finally { r.e.sqlite.close(); }
  });

  it('the owner may add their own admin machine; non-owner admins cannot mint admin/owner', async () => {
    const r = rig();
    try {
      for (const [github, allowed] of [['583231', true], ['770003', false]] as const) {
        const start = await r.start();
        const response = await r.decide(start.user_code, 'approve', github);
        expect(response.status).toBe(allowed ? 200 : 404);
        const joined = await r.poll(start.device_code);
        expect(joined).toMatchObject(allowed ? { joined: true, memberId: OWNER, role: 'admin' } : { error: 'authorization_pending' });
      }
      const start = await r.start();
      for (const extra of [{ memberId: OWNER }, { role: 'admin' }, { role: 'owner' }]) {
        expect((await r.post('/api/device/approve', { user_code: start.user_code, ...extra }, await ownerCookie(NOW, '770001'))).status).toBe(400);
      }
    } finally { r.e.sqlite.close(); }
  });

  it('no cookie or cross-origin request approves a machine; both public routes charge the source bucket', async () => {
    const r = rig();
    try {
      const start = await r.start();
      expect((await r.post('/api/device/approve', { user_code: start.user_code })).status).toBe(401);
      expect((await r.post('/api/device/approve', { user_code: start.user_code }, await ownerCookie(NOW, '770001'), 'https://attacker')).status).toBe(403);
      r.env.sourceLimit = { limit: async () => ({ success: false }) };
      expect((await r.post('/auth/device/start', { machineId: 'new', machineName: 'New', os: 'linux' })).status).toBe(429);
      expect((await r.post('/auth/device/poll', { device_code: start.device_code })).status).toBe(429);
      expect((await r.decide(start.user_code, 'preview')).status).toBe(200);
      r.env.tokenLimit = { limit: async () => ({ success: false }) };
      expect((await r.decide(start.user_code, 'preview')).status).toBe(429);
    } finally { r.e.sqlite.close(); }
  });

  it('unapproved device secrets cannot use the invite join route, and concurrent redemption mints once', async () => {
    const r = rig();
    try {
      const start = await r.start('racing_device');
      expect(await json(await r.post('/members/join', { key: start.device_code, machineId: 'racing_device' }))).toMatchObject({ joined: false, code: 'enrollment_unknown' });
      await r.decide(start.user_code);
      expect(await json(await r.post('/members/join', { key: start.device_code, machineId: 'substituted_machine' }))).toMatchObject({ joined: false, code: 'identity_claimed' });
      const before = r.count();
      const replies = await Promise.all([r.poll(start.device_code), r.poll(start.device_code)]);
      expect(replies.filter(x => x.joined === true)).toHaveLength(1);
      expect(r.count()).toBe(before + 1);
    } finally { r.e.sqlite.close(); }
  });

  it('revocation after approval voids redemption and a claimed machine stays with its existing member', async () => {
    const r = rig();
    try {
      const start = await r.start();
      await r.decide(start.user_code);
      r.e.sqlite.run(`UPDATE members SET revoked_at = ${NOW} WHERE id = '${MEMBER}'`);
      expect(await r.poll(start.device_code)).toEqual({ error: 'invalid_grant' });
      r.e.sqlite.run(`UPDATE members SET revoked_at = NULL WHERE id = '${MEMBER}'`);
      const claimed = await r.start('device_foreign');
      r.e.sqlite.run(`INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES ('device_foreign','${OWNER}',${NOW})`);
      await r.decide(claimed.user_code);
      expect(await r.poll(claimed.device_code)).toEqual({ error: 'identity_claimed' });
    } finally { r.e.sqlite.close(); }
  });

  it('approval rechecks live authority at its insert, including owner transfer and member revocation', async () => {
    for (const owner of [false, true]) {
      let armed = false;
      const r = rig((sql, sqlite) => {
        if (!armed || !sql.includes('INSERT INTO enrollment_authorities')) return;
        armed = false;
        if (owner) sqlite.run(`UPDATE deployment_ownership SET member_id = '${ADMIN}' WHERE id = 1`);
        else sqlite.run(`UPDATE members SET revoked_at = ${NOW} WHERE id = '${MEMBER}'`);
      });
      try {
        const start = await r.start();
        armed = true;
        expect((await r.decide(start.user_code, 'approve', owner ? '583231' : '770001')).status).toBe(409);
        expect(r.e.sqlite.query('SELECT decision FROM device_requests').get()).toEqual({ decision: null });
        expect(await r.poll(start.device_code)).toEqual({ error: 'authorization_pending' });
        expect(await r.e.serverEnv.db.prepare('SELECT id FROM enrollment_authorities WHERE key_hash = ?').bind(await sha256Hex(start.device_code)).first()).toBeNull();
      } finally { r.e.sqlite.close(); }
    }
  });
});
