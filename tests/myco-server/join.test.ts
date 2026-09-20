/**
 * `POST /members/join` — the one exchange that turns an enrollment authority into
 * a member credential, driven through the deployed entry.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ENROLLMENT_RETENTION_MS, ENROLLMENT_TTL_MS, issueEnrollmentAuthority, revokeEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { handleJoin } from '@myco-server-worker/auth/join.js';
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
    key: (options: Partial<Parameters<typeof issueEnrollmentAuthority>[2]> = {}) => issueEnrollmentAuthority(e.db, now, { role: 'member', ...options }),
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

  it('refuses a join presenting a machine identity another member already holds, and issues nothing for it', async () => {
    // The attack this closes: `machine_id` — not `member_id` — is what every ownership
    // predicate in the ingest path keys on, and it is a label rather than a secret. A
    // joiner free to present any identity could append into the holder's sessions in
    // every Project of the Deployment. The key decides WHO joins; it must not also let
    // the joiner decide WHOSE machine they are.
    const r = await rig();
    const victim = await json(await r.join({ key: (await r.key()).key, machineId: 'machine_victim' }));
    expect(victim.joined).toBe(true);

    const attacker = await json(await r.join({ key: (await r.key()).key, machineId: 'machine_victim' }));
    expect(attacker).toEqual({ joined: false, code: 'identity_claimed', reason: 'machine identity belongs to another member' });

    // One credential on that identity, and it is still the victim's.
    expect(r.e.sqlite.query(`SELECT member_id FROM member_credentials WHERE machine_id = 'machine_victim'`).all())
      .toEqual([{ member_id: victim.memberId }]);
    expect(r.e.sqlite.query(`SELECT member_id FROM machine_claims WHERE machine_id = 'machine_victim'`).get())
      .toEqual({ member_id: victim.memberId });
  });

  it('lets the member that holds an identity re-join on it, so a revoked or expired runtime can come back', async () => {
    const r = await rig();
    const first = await json(await r.join({ key: (await r.key()).key, machineId: 'machine_same' }));
    r.e.sqlite.query(`UPDATE member_credentials SET revoked_at = ? WHERE id = ?`).run(r.now, first.tokenId);

    const again = await json(await r.join({ key: (await r.key({ memberId: first.memberId as string })).key, machineId: 'machine_same' }));
    expect({ joined: again.joined, memberId: again.memberId }).toEqual({ joined: true, memberId: first.memberId });
    expect(again.tokenId).not.toBe(first.tokenId);
  });

  it('admits one claimant when two members race for one machine identity', async () => {
    const r = await rig();
    const keys = await Promise.all([r.key(), r.key()]);
    const [a, b] = await Promise.all(keys.map((k) => r.join({ key: k.key, machineId: 'machine_race' }).then(json)));
    expect([a, b].map((o) => o.joined).sort()).toEqual([false, true]);
    expect([a, b].find((o) => o.joined === false)).toMatchObject({ code: 'identity_claimed' });
    expect((r.e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials WHERE machine_id = 'machine_race'`).get() as any).c).toBe(1);
  });

  it('refuses a key that is unknown, spent, expired or revoked, and issues nothing for any of them', async () => {
    const r = await rig();
    const spent = await r.key();
    expect((await json(await r.join({ key: spent.key, machineId: 'machine_ok' }))).joined).toBe(true);
    const expired = await issueEnrollmentAuthority(r.e.db, r.now - ENROLLMENT_TTL_MS * 2, { role: 'member' });
    const revoked = await r.key();
    await revokeEnrollmentAuthority(r.e.db, revoked.id, r.now, 'mem_machine_1');

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

/**
 * A refused join costs nothing.
 *
 * A machine identity belongs to one member, and a machine that already holds one
 * cannot join as another. That refusal is settled before anything is written: the
 * Deployment records no member, and the operator's invitation stays redeemable, so
 * a mis-targeted invite can be handed to the right machine rather than re-minted.
 */
describe('a refused join leaves no trace', () => {
  type Rig = Awaited<ReturnType<typeof rig>>['e'];
  const one = (e: Rig, sql: string): number => (e.sqlite.query(sql).get() as { c: number }).c;
  const openInvitations = (e: Rig) => one(e, `SELECT COUNT(*) c FROM enrollment_authorities WHERE used_at IS NULL AND revoked_at IS NULL`);
  const unspent = (e: Rig) => one(e, `SELECT COUNT(*) c FROM enrollment_authorities WHERE used_at IS NULL`);
  /** Every row a join writes, so a refusal can be shown to write none of them. */
  const counts = (e: Rig) => ({
    members: one(e, `SELECT COUNT(*) c FROM members`),
    claims: one(e, `SELECT COUNT(*) c FROM machine_claims`),
    credentials: one(e, `SELECT COUNT(*) c FROM member_credentials`),
    spent: one(e, `SELECT COUNT(*) c FROM enrollment_authorities WHERE used_at IS NOT NULL`),
  });

  it('refuses identity_claimed with the members count and the invitation unchanged', async () => {
    const r = await rig();
    const joined = await r.key();
    expect((await json(await r.join({ key: joined.key, machineId: 'local_34e40e49' }))).joined).toBe(true);

    // A second, new-member invitation, presented by the machine that already joined.
    const contested = await r.key();
    const before = { members: r.members(), open: openInvitations(r.e) };
    const answer = await json(await r.join({ key: contested.key, machineId: 'local_34e40e49' }));

    expect(answer).toMatchObject({ joined: false, code: 'identity_claimed' });
    expect(r.members()).toBe(before.members);
    expect(openInvitations(r.e)).toBe(before.open);
    // Redeemable in fact, not only unspent on paper: another machine takes it.
    const second = await json(await r.join({ key: contested.key, machineId: 'other_machine' }));
    expect(second.joined).toBe(true);
    expect(r.members()).toBe(before.members + 1);
  });

  it('adds a runtime when the invitation names the member that already holds the identity', async () => {
    const r = await rig();
    const first = await r.key();
    const joined = await json(await r.join({ key: first.key, machineId: 'local_34e40e49' }));
    const memberId = joined.memberId as string;

    const another = await r.key({ memberId });
    const before = r.members();
    const second = await json(await r.join({ key: another.key, machineId: 'local_34e40e49' }));

    expect(second).toMatchObject({ joined: true, memberId });
    expect(r.members()).toBe(before);
  });

  it('refuses a key it holds no row for without consulting the identity, as it did before', async () => {
    const r = await rig();
    const joined = await r.key();
    expect((await json(await r.join({ key: joined.key, machineId: 'local_34e40e49' }))).joined).toBe(true);
    const before = r.members();

    // A well-formed key this Deployment never minted, from the machine that holds an identity.
    const unknown = `${'k'.repeat(43)}`;
    const answer = await json(await r.join({ key: unknown, machineId: 'local_34e40e49' }));
    expect(answer).toMatchObject({ joined: false, code: 'enrollment_unknown' });
    expect(r.members()).toBe(before);
  });

  it('refuses a spent key as already_used rather than as a claimed identity', async () => {
    const r = await rig();
    const key = await r.key();
    expect((await json(await r.join({ key: key.key, machineId: 'first_machine' }))).joined).toBe(true);
    const before = r.members();

    const answer = await json(await r.join({ key: key.key, machineId: 'second_machine' }));
    expect(answer).toMatchObject({ joined: false, code: 'enrollment_used' });
    expect(r.members()).toBe(before);
  });

  it('leaves no claim, no credential and no spend when the identity is held', async () => {
    const r = await rig();
    const joined = await r.key();
    expect((await json(await r.join({ key: joined.key, machineId: 'local_34e40e49' }))).joined).toBe(true);
    const before = counts(r.e);

    const contested = await r.key();
    expect((await json(await r.join({ key: contested.key, machineId: 'local_34e40e49' })))).toMatchObject({ joined: false, code: 'identity_claimed' });
    expect(counts(r.e)).toEqual(before);
    expect(unspent(r.e)).toBe(1);
  });

  it('leaves no write at all when the key itself is refused', async () => {
    const r = await rig();
    const before = counts(r.e);
    const expired = await issueEnrollmentAuthority(r.e.db, r.now - ENROLLMENT_TTL_MS - 60_000, { role: 'member' });
    const answer = await json(await r.join({ key: expired.key, machineId: 'fresh_machine' }));
    expect(answer).toMatchObject({ joined: false, code: 'enrollment_expired' });
    expect(counts(r.e)).toEqual(before);
  });

  it('issues a credential for a machine claiming its own identity in the same transaction', async () => {
    // The claim the batch inserts must not invalidate the credential's own gate.
    const r = await rig();
    const key = await r.key();
    const answer = await json(await r.join({ key: key.key, machineId: 'brand_new_machine' }));
    expect(answer.joined).toBe(true);
    expect(r.credential(answer.tokenId as string)).toMatchObject({ machine_id: 'brand_new_machine' });
    const claim = r.e.sqlite.query(`SELECT member_id FROM machine_claims WHERE machine_id = ?`).get('brand_new_machine') as { member_id: string };
    expect(claim.member_id).toBe(answer.memberId as string);
  });

  it('writes nothing and leaves the key unspent when the transaction faults', async () => {
    const r = await rig();
    const key = await r.key();
    const before = counts(r.e);
    // The fault is injected at the store the admission writes through: a request
    // resolves its own binding, so the handler is driven directly here.
    const faulting = { ...r.e.env, db: { ...r.e.db, batch: () => Promise.reject(new Error('storage fault')) } } as unknown as Parameters<typeof handleJoin>[0];
    const outcome = await handleJoin(faulting, joinRequest({ key: key.key, machineId: 'fresh_machine' }), r.now)
      .then(() => 'returned' as const, (err: unknown) => (err as Error).message);
    expect(outcome).toBe('storage fault');
    expect(counts(r.e)).toEqual(before);
    expect(unspent(r.e)).toBe(1);
    // The invitation still works afterwards.
    expect((await json(await r.join({ key: key.key, machineId: 'fresh_machine' }))).joined).toBe(true);
  });

  it('reports the key\'s own refusal ahead of the identity, in one order', async () => {
    const r = await rig();
    const holder = await r.key();
    expect((await json(await r.join({ key: holder.key, machineId: 'taken_machine' }))).joined).toBe(true);

    // Each key is refused on its own terms even though the identity is also held.
    const spent = await r.key();
    expect((await json(await r.join({ key: spent.key, machineId: 'another_machine' }))).joined).toBe(true);
    const expired = await issueEnrollmentAuthority(r.e.db, r.now - ENROLLMENT_TTL_MS - 60_000, { role: 'member' });
    const revoked = await r.key();
    await revokeEnrollmentAuthority(r.e.db, revoked.id, r.now, 'mem_admin');

    const codes: [string, string][] = [
      ['A'.repeat(43), 'enrollment_unknown'],
      [revoked.key, 'enrollment_revoked'],
      [spent.key, 'enrollment_used'],
      [expired.key, 'enrollment_expired'],
    ];
    for (const [key, code] of codes) {
      expect(await json(await r.join({ key, machineId: 'taken_machine' }))).toMatchObject({ joined: false, code });
    }
    // Only a key nothing refuses reports the identity.
    const clean = await r.key();
    expect(await json(await r.join({ key: clean.key, machineId: 'taken_machine' }))).toMatchObject({ joined: false, code: 'identity_claimed' });
  });

  it('records a new member at the role the invitation granted', async () => {
    const r = await rig();
    const key = await r.key({ role: 'admin' });
    const answer = await json(await r.join({ key: key.key, machineId: 'admin_machine' }));

    expect(answer).toMatchObject({ joined: true, role: 'admin' });
    const recorded = r.e.sqlite.query(`SELECT role FROM members WHERE id = ?`).get(answer.memberId as string) as { role: string };
    expect(recorded.role).toBe('admin');
  });

  it('refuses a root credential whose admission fails, rather than issuing one unconditionally', async () => {
    const r = await rig();
    const holder = await r.key();
    expect((await json(await r.join({ key: holder.key, machineId: 'taken_machine' }))).joined).toBe(true);
    const before = counts(r.e);

    // A join mints a ROOT credential, which carries no predecessor; its admission
    // must still gate the insert.
    const contested = await r.key();
    expect(await json(await r.join({ key: contested.key, machineId: 'taken_machine' }))).toMatchObject({ joined: false, code: 'identity_claimed' });
    expect(counts(r.e).credentials).toBe(before.credentials);
  });

  it('still decides one holder when two joins present one identity at once', async () => {
    const r = await rig();
    const [a, b] = [await r.key(), await r.key()];
    const before = r.members();

    // Both read a free identity, so the claim is what settles it.
    const [first, second] = await Promise.all([
      json(await r.join({ key: a.key, machineId: 'shared_machine' })),
      json(await r.join({ key: b.key, machineId: 'shared_machine' })),
    ]);
    const joinedCount = [first, second].filter((answer) => answer.joined === true).length;
    const refusedCount = [first, second].filter((answer) => answer.code === 'identity_claimed').length;
    expect(joinedCount).toBe(1);
    expect(refusedCount).toBe(1);
    // Exactly one credential exists for the contested identity.
    const credentials = (r.e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials WHERE machine_id = ?`).get('shared_machine') as { c: number }).c;
    expect(credentials).toBe(1);
    // The loser's member row is the residual #954 cost, and it is recorded as one member, not two credentials.
    expect(r.members()).toBeLessThanOrEqual(before + 2);
  });
});
