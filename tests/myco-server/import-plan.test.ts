/**
 * What the Deployment tells a member to ship, and what it refuses outright.
 *
 * The plan is advice: everything it applies the write path applies again, so
 * nothing here is the gate. What it is responsible for is that a member never
 * spends bytes on a write that will be refused, and never offers a candidate
 * under a Project or a session that cannot take it.
 *
 * Two answers carry the whole of the correctness argument and are asserted
 * against each other rather than alone. A transcript whose held head digest
 * disagrees is `replaced`. A DIFFERENT identity for a session already held is
 * `session_held` only when its head digest MATCHES: an equal digest is the same
 * file renamed, a different one is a rotation, and a rotation is history the
 * member must still be told to ship. Refusing both would drop the later half of
 * every rotated session, permanently and without saying so.
 */
import { jsonBody, objectAt } from '../helpers/json-body.js';
import { describe, expect, it } from 'bun:test';
import { handleImportPlan } from '@myco-server-worker/api/import.js';
import { IMPORT_MAX_SESSIONS_DEFAULT, IMPORT_WINDOW_DAYS_DEFAULT } from '@myco-server-worker/core/import-policy.js';
import { MEMBER_TOKEN_BYTE_QUOTA } from '@myco-server-worker/constants.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { sqliteEnv, count } from './helpers/fixtures.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const PROJECT = 'proj_1';
const MACHINE = 'machine_1';
const DAY = 86_400_000;
const hash = (c: string) => c.repeat(64);

interface Offer {
  sessionId: string;
  transcriptId: string;
  agent?: string;
  sizeBytes?: number;
  modifiedAt?: number;
  headHash?: string | null;
}

async function rig() {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);

  /** A transcript the Deployment already holds. */
  const hold = (sessionId: string, transcriptId: string, size: number, headHash: string | null, role = 'primary') => {
    sqlite.run(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES (?, ?, ?, ?, ?, ?)`, [PROJECT, sessionId, MACHINE, issued.tokenId, NOW, NOW]);
    sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, role, head_hash, size, segment_count, first_received_at, last_received_at, token_id)
                VALUES (?, ?, ?, ?, 'claude-code', ?, ?, ?, 1, ?, ?, ?)`,
               [PROJECT, transcriptId, sessionId, MACHINE, role, headHash, size, NOW, NOW, issued.tokenId]);
  };

  const tombstone = (sessionId: string) => {
    sqlite.run(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES (?, ?, ?, ?, ?, ?)`, [PROJECT, sessionId, MACHINE, issued.tokenId, NOW, NOW]);
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, ?, NULL, ?, 'mem_machine_1')`, [PROJECT, sessionId, NOW]);
  };

  // Through the settings writer, not a hand-rolled INSERT: what the admission
  // compares against is the text `setLeaf` stores, so a test that writes its own
  // encoding proves the admission agrees with the test rather than with the
  // mechanism.
  const leaf = (name: string, value: unknown) => settingsWriter(serverEnv.db).setLeaf(name, value, 'mem_machine_1', NOW);

  /** Charge the credential so only `room` bytes are left. */
  const spend = (room: number) =>
    sqlite.run(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`, [MEMBER_TOKEN_BYTE_QUOTA - room, issued.tokenId]);

  const plan = async (offers: readonly Offer[], over: Record<string, unknown> = {}) => {
    const body = JSON.stringify({
      ...over,
      candidates: offers.map((o) => ({
        sessionId: o.sessionId, transcriptId: o.transcriptId, agent: o.agent ?? 'claude-code',
        sizeBytes: o.sizeBytes ?? 1000, modifiedAt: o.modifiedAt ?? NOW, headHash: o.headHash ?? null,
      })),
    });
    const ctx = { projectId: PROJECT, machineId: MACHINE, tokenId: issued.tokenId, bodyBytes: body.length, now: NOW, body, origin: null } as never;
    return await jsonBody<Record<string, unknown>>(await handleImportPlan(serverEnv, ctx));
  };

  /** Every candidate's answer, keyed by identity, so an assertion names the transcript rather than a position. */
  const answers = async (offers: readonly Offer[], over: Record<string, unknown> = {}) => {
    const body = await plan(offers, over);
    const list = (body.candidates ?? []) as unknown as Array<{ transcriptId: string; take: string; reason?: string; fromOffset?: number }>;
    return new Map(list.map((a) => [a.transcriptId, a]));
  };

  return { sqlite, serverEnv, hold, tombstone, leaf, spend, plan, answers, tokenId: issued.tokenId };
}

describe('the import plan', () => {
  it('refuses a tombstoned session, and still refuses it once the session has been captured live', async () => {
    const r = await rig();
    r.tombstone('s-dead');
    expect((await r.answers([{ sessionId: 's-dead', transcriptId: 'tx_a' }])).get('tx_a')).toEqual({ transcriptId: 'tx_a', take: 'none', reason: 'tombstoned' });

    // A live capture of the same session does not lift the tombstone.
    r.hold('s-dead', 'tx_live', 500, hash('a'));
    expect((await r.answers([{ sessionId: 's-dead', transcriptId: 'tx_a' }])).get('tx_a')?.reason).toBe('tombstoned');
  });

  it('answers held in full, and the held size for one held in part', async () => {
    const r = await rig();
    r.hold('s1', 'tx_full', 1000, null);
    r.hold('s2', 'tx_part', 400, null);
    const got = await r.answers([
      { sessionId: 's1', transcriptId: 'tx_full', sizeBytes: 1000 },
      { sessionId: 's2', transcriptId: 'tx_part', sizeBytes: 1000 },
    ]);
    expect(got.get('tx_full')).toEqual({ transcriptId: 'tx_full', take: 'none', reason: 'held' });
    expect(got.get('tx_part')).toEqual({ transcriptId: 'tx_part', take: 'from', fromOffset: 400 });
  });

  it('refuses a transcript whose head digest disagrees, and one the Deployment holds more of than the file has', async () => {
    const r = await rig();
    r.hold('s1', 'tx_rewritten', 400, hash('a'));
    r.hold('s2', 'tx_ahead', 5000, null);
    const got = await r.answers([
      { sessionId: 's1', transcriptId: 'tx_rewritten', sizeBytes: 1000, headHash: hash('b') },
      { sessionId: 's2', transcriptId: 'tx_ahead', sizeBytes: 1000 },
    ]);
    expect(got.get('tx_rewritten')?.reason).toBe('replaced');
    expect(got.get('tx_ahead')?.reason).toBe('replaced');
  });

  it('refuses a moved file under a new identity, and ADMITS a rotation of the same session', async () => {
    const r = await rig();
    // One session, one held primary transcript whose head is `a`.
    r.hold('s1', 'tx_held', 400, hash('a'));
    const got = await r.answers([
      // The same file renamed: a new identity, the same first bytes.
      { sessionId: 's1', transcriptId: 'tx_moved', sizeBytes: 1000, headHash: hash('a') },
      // A rotation: a new identity and genuinely different first bytes.
      { sessionId: 's1', transcriptId: 'tx_rotated', sizeBytes: 1000, headHash: hash('z') },
    ]);
    expect(got.get('tx_moved')).toEqual({ transcriptId: 'tx_moved', take: 'none', reason: 'session_held' });
    // The negative half. Refusing this would drop the later part of every
    // rotated session, silently and on every run.
    expect(got.get('tx_rotated')).toEqual({ transcriptId: 'tx_rotated', take: 'from', fromOffset: 0 });
  });

  it('compares against the session\'s primary transcripts, not its subagent siblings', async () => {
    const r = await rig();
    // A sibling shares the session and may share a head digest, but it is a
    // different file. Matching against it would refuse a primary transcript
    // that has never been shipped.
    r.hold('s1', 'tx_sibling', 400, hash('a'), 'subagent');
    const got = await r.answers([{ sessionId: 's1', transcriptId: 'tx_primary', sizeBytes: 1000, headHash: hash('a') }]);
    expect(got.get('tx_primary')).toEqual({ transcriptId: 'tx_primary', take: 'from', fromOffset: 0 });
  });

  it('applies the window and the per-agent cap, admits a caller that asks wider, and refuses the whole ask when import is off', async () => {
    const r = await rig();
    const old = { sessionId: 's-old', transcriptId: 'tx_old', modifiedAt: NOW - 60 * DAY };
    expect((await r.answers([old])).get('tx_old')?.reason).toBe('window');
    expect((await r.answers([old], { windowDays: 90 })).get('tx_old')?.take).toBe('from');

    const many = Array.from({ length: 3 }, (_, i) => ({ sessionId: `s${i}`, transcriptId: `tx_${i}` }));
    const capped = await r.answers(many, { maxPerAgent: 2 });
    expect(many.map((m) => capped.get(m.transcriptId)?.take)).toEqual(['from', 'from', 'none']);
    expect(capped.get('tx_2')?.reason).toBe('cap');

    await r.leaf('import.enabled', false);
    const outcome = await r.plan([{ sessionId: 's1', transcriptId: 'tx_a' }]);
    expect({ persisted: outcome.persisted, code: outcome.code }).toEqual({ persisted: false, code: 'import_disabled' });
    // Even a caller asking for a wider window is refused while the switch is off.
    expect((await r.plan([{ sessionId: 's1', transcriptId: 'tx_a' }], { windowDays: 90 })).code).toBe('import_disabled');
  });

  it('spends the quota per whole transcript, lets a smaller one fit after a larger one did not, and writes nothing', async () => {
    const r = await rig();
    r.spend(1500);
    const got = await r.answers([
      { sessionId: 's1', transcriptId: 'tx_big', sizeBytes: 1200 },
      { sessionId: 's2', transcriptId: 'tx_bigger', sizeBytes: 1000 },
      { sessionId: 's3', transcriptId: 'tx_small', sizeBytes: 200 },
    ]);
    expect(got.get('tx_big')?.take).toBe('from');
    // Does not fit whole: refused rather than half-admitted.
    expect(got.get('tx_bigger')).toEqual({ transcriptId: 'tx_bigger', take: 'none', reason: 'quota' });
    // A later, smaller one still fits the room the refused one did not take.
    expect(got.get('tx_small')?.take).toBe('from');

    // The plan is advice. It stores nothing and charges nothing.
    expect([count(r.sqlite, 'blobs'), count(r.sqlite, 'events'), count(r.sqlite, 'transcript_segments')]).toEqual([0, 0, 0]);
    expect((r.sqlite.query(`SELECT bytes_written AS b FROM member_credentials WHERE id = ?`).get(r.tokenId) as { b: number }).b)
      .toBe(MEMBER_TOKEN_BYTE_QUOTA - 1500);
  });

  it('admits a new identity it cannot compare, and says so', async () => {
    const r = await rig();
    // A hook-shipped transcript carries no head digest until the live path
    // sends one, so a new identity for its session cannot be told from a
    // rotation. Admitting may re-derive; refusing would silently lose the
    // later half of a rotated session, which is the worse of the two.
    r.hold('s1', 'tx_nohash', 400, null);

    const emitted: string[] = [];
    const held = console.log;
    console.log = (line: string) => { emitted.push(line); };
    let got;
    try {
      got = await r.answers([{ sessionId: 's1', transcriptId: 'tx_new', sizeBytes: 1000, headHash: hash('a') }]);
    } finally {
      console.log = held;
    }
    expect(got.get('tx_new')).toEqual({ transcriptId: 'tx_new', take: 'from', fromOffset: 0 });
    // The residual is countable while it is open. Asserted here rather than
    // left to the emit-arity counter, which a second emit anywhere satisfies.
    const signal = emitted.map((l) => JSON.parse(l) as { kind: string; pairs?: number }).filter((e) => e.kind === 'import_identity_uncompared');
    expect(signal).toEqual([{ kind: 'import_identity_uncompared', projectId: PROJECT, pairs: 1 } as never]);
  });

  it('says nothing when every held transcript could be compared', async () => {
    const r = await rig();
    r.hold('s1', 'tx_hashed', 400, hash('a'));
    const emitted: string[] = [];
    const held = console.log;
    console.log = (line: string) => { emitted.push(line); };
    try {
      await r.answers([{ sessionId: 's1', transcriptId: 'tx_new', sizeBytes: 1000, headHash: hash('z') }]);
    } finally {
      console.log = held;
    }
    expect(emitted.filter((l) => l.includes('import_identity_uncompared'))).toEqual([]);
  });

  it('answers the bounds it ran under, defaulting to the anchor’s window and cap', async () => {
    const r = await rig();
    expect((await r.plan([])).policy).toEqual({ enabled: true, windowDays: IMPORT_WINDOW_DAYS_DEFAULT, maxPerAgent: IMPORT_MAX_SESSIONS_DEFAULT });
    await r.leaf('import.window_days', 7);
    expect((objectAt(await r.plan([]), 'policy')).windowDays).toBe(7);
  });
});
