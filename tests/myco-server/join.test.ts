/**
 * `POST /members/join` — the one exchange that turns an enrollment authority into
 * a member credential, driven through the deployed entry.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ENROLLMENT_TTL_MS, issueEnrollmentAuthority, revokeEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { MEMBER_TOKEN_PATTERN } from '@myco-server-worker/auth/tokens.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';
import { createIngestThrottle } from './helpers/throttle.js';

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

const joinRequest = (body: unknown) =>
  new Request('https://s/members/join', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const rig = async (opts: { sourceLimit?: number } = {}) => {
  const e = sqliteEnv();
  const now = Date.now();
  if (opts.sourceLimit !== undefined) e.env.SOURCE_LIMIT = createIngestThrottle(opts.sourceLimit, 60_000, 100, () => 0);
  const members = () => (e.sqlite.query(`SELECT COUNT(*) c FROM members`).get() as { c: number }).c;
  const seededMembers = members();
  return {
    e, now, members, seededMembers,
    join: (body: unknown) => worker.fetch(joinRequest(body), e.env),
    key: (options: Parameters<typeof issueEnrollmentAuthority>[2] = {}) => issueEnrollmentAuthority(e.db, now, options),
    credential: (id: string) => e.sqlite.query(`SELECT member_id, machine_id, runtime_label, runtime_kind, predecessor_id, bytes_written FROM member_credentials WHERE id = ?`).get(id) as Record<string, unknown>,
  };
};

describe('member join', () => {
  it('exchanges a key for a credential that authenticates, names a server-chosen member, and records the runtime as a claim', async () => {
    const r = await rig();
    const key = await r.key();
    const body = await json(await r.join({ key: key.key, machineId: 'machine_j', runtimeLabel: 'laptop', runtimeKind: 'persistent' }));

    expect(body.joined).toBe(true);
    expect(MEMBER_TOKEN_PATTERN.test(body.token as string)).toBe(true);
    expect((body.memberId as string).startsWith('mem_')).toBe(true);
    expect((body.tokenId as string).startsWith('mt_')).toBe(true);
    // The member is named by the server. Nothing the joiner sent decides it.
    expect(body.memberId).not.toBe('machine_j');

    expect(r.credential(body.tokenId as string)).toEqual({
      member_id: body.memberId, machine_id: 'machine_j', runtime_label: 'laptop', runtime_kind: 'persistent',
      predecessor_id: null, bytes_written: 0,
    });

    // The credential works: it is a full member credential, not a provisional one.
    const posted = await worker.fetch(new Request('https://s/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${body.token as string}`, 'cf-connecting-ip': '1.2.3.4', [PROJECT_HEADER]: 'proj_1', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
      body: JSON.stringify(envelope({ eventId: uuid(11), machineId: undefined })),
    }), r.e.env);
    expect((await json(posted)).persisted).toBe(true);
  });

  it('admits exactly one credential when two runtimes race one key, and the loser is told the key is spent', async () => {
    const r = await rig();
    const key = await r.key();
    const [a, b] = await Promise.all([
      json(await r.join({ key: key.key, machineId: 'machine_a' })),
      json(await r.join({ key: key.key, machineId: 'machine_b' })),
    ]);
    const outcomes = [a, b].map((o) => o.joined).sort();
    expect(outcomes).toEqual([false, true]);
    expect([a, b].find((o) => o.joined === false)).toMatchObject({ code: 'enrollment_used' });
    expect((r.e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get() as any).c).toBe(1);
    // One member too: a losing join must not leave an identity nothing holds.
    expect(r.members() - r.seededMembers).toBe(1);
  });

  it('adds a runtime to an existing member when the key names one, so one person on two machines is one identity', async () => {
    const r = await rig();
    const first = await json(await r.join({ key: (await r.key()).key, machineId: 'machine_1' }));
    const second = await json(await r.join({ key: (await r.key({ memberId: first.memberId as string })).key, machineId: 'machine_2' }));

    expect([first.joined, second.joined]).toEqual([true, true]);
    expect(second.memberId).toBe(first.memberId);
    expect(second.tokenId).not.toBe(first.tokenId);
    // Two credentials, two machines, one member — and each credential keeps its own machine.
    expect(r.e.sqlite.query(`SELECT member_id, machine_id FROM member_credentials ORDER BY machine_id`).all()).toEqual([
      { member_id: first.memberId, machine_id: 'machine_1' },
      { member_id: first.memberId, machine_id: 'machine_2' },
    ]);
    expect(r.members() - r.seededMembers).toBe(1);
  });

  it('refuses a key that is unknown, spent, expired or revoked, and issues nothing for any of them', async () => {
    const r = await rig();
    const spent = await r.key();
    expect((await json(await r.join({ key: spent.key, machineId: 'machine_ok' }))).joined).toBe(true);
    const expired = await issueEnrollmentAuthority(r.e.db, r.now - ENROLLMENT_TTL_MS * 2);
    const revoked = await r.key();
    await revokeEnrollmentAuthority(r.e.db, revoked.id, r.now);

    const cases: Array<[string, string]> = [
      ['n'.repeat(43), 'enrollment_unknown'],
      [spent.key, 'enrollment_used'],
      [expired.key, 'enrollment_expired'],
      [revoked.key, 'enrollment_revoked'],
    ];
    for (const [key, code] of cases) {
      const body = await json(await r.join({ key, machineId: 'machine_x' }));
      expect({ code, joined: body.joined, answered: body.code }).toEqual({ code, joined: false, answered: code });
    }
    // Only the one successful join issued anything.
    expect((r.e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get() as any).c).toBe(1);
  });

  it('refuses a malformed request by name, before spending the key', async () => {
    const r = await rig();
    const key = await r.key();
    const cases: Array<[unknown, string]> = [
      ['not json', 'parse'],
      [[], 'parse'],
      [{ machineId: 'machine_x' }, 'enrollment_unknown'],
      [{ key: key.key }, 'id_grammar'],
      [{ key: key.key, machineId: 'has space' }, 'id_grammar'],
      [{ key: key.key, machineId: 'machine_x', runtimeKind: 'has space' }, 'id_grammar'],
      [{ key: key.key, machineId: 'machine_x', memberId: 'mem_theirs' }, 'unknown_field'],
    ];
    for (const [body, code] of cases) {
      const answer = await json(await r.join(body));
      expect({ body, joined: answer.joined, code: answer.code }).toEqual({ body, joined: false, code });
    }
    // Every refusal above left the key unspent: it still works.
    expect((await json(await r.join({ key: key.key, machineId: 'machine_x' }))).joined).toBe(true);
  });

  it('is metered by source like every other credential-free request: a guesser is rate limited rather than left guessing', async () => {
    const r = await rig({ sourceLimit: 5 });
    const limited: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const res = await r.join({ key: `${'g'.repeat(42)}${i % 10}`, machineId: 'machine_g' });
      limited.push(res.status);
      if (res.status === 429) break;
    }
    expect(limited).toContain(429);
    expect((r.e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get() as any).c).toBe(0);
  });
});
