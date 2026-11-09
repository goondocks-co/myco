import { describe, expect, it } from 'bun:test';
import { heldTranscriptsFor, listTranscripts, pageSegments, sessionsWithTranscript } from '@myco-server-worker/read/transcript.js';
import { sqliteEnv } from './helpers/fixtures.js';

type Env = ReturnType<typeof sqliteEnv>;
const SCOPE = { projectId: 'proj_1' };
const transcript = (e: Env, id: string, session: string, role = 'primary', size = 10, machine = 'm1') => e.sqlite.run(
  `INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, role, size, segment_count, first_received_at, last_received_at, token_id, prompt_identity_scheme, head_hash)
    VALUES ('proj_1', ?, ?, ?, ?, ?, 1, 0, 0, 't', 'offset-v1', 'head')`, [id, session, machine, role, size]);
const segment = (e: Env, id: string, offset: number, length: number) => e.sqlite.run(
  `INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
    VALUES ('proj_1', ?, ?, ?, ?, 'e', 0, 0, 't')`, [id, offset, length, `b${offset}`.padStart(64, '0')]);

describe('import discovery', () => {
  it('finds a session\'s every rotation past the page size, and the identities asked for', async () => {
    const e = sqliteEnv();
    for (let n = 0; n < 230; n += 1) transcript(e, `tx-${String(n).padStart(4, '0')}`, 'rotated');
    transcript(e, 'tx-identity', 'other');
    const held = await heldTranscriptsFor(e.db, SCOPE, ['rotated'], ['tx-identity']);
    expect(held).toHaveLength(231);
    expect(held.filter(row => row.sessionId === 'rotated')).toHaveLength(230);
  });

  it('answers which sessions hold a transcript, and nothing for no sessions', async () => {
    const e = sqliteEnv();
    for (let n = 0; n < 50; n += 1) transcript(e, `tx-${n}`, 'busy');
    const sessions = ['busy', 'empty', 'absent'];
    transcript(e, 'tx-empty', 'empty', 'primary', 0);
    expect([...await sessionsWithTranscript(e.db, SCOPE, sessions)].sort()).toEqual(['busy', 'empty']);
    expect([...await sessionsWithTranscript(e.db, SCOPE, sessions, { nonEmpty: true })].sort()).toEqual(['busy']);
    expect([...await sessionsWithTranscript(e.db, SCOPE, [])]).toEqual([]);
  });

  it('reads nothing for nothing asked', async () => {
    const e = sqliteEnv();
    expect(await heldTranscriptsFor(e.db, SCOPE, [], [])).toEqual([]);
  });

  it('counts only one machine\'s transcripts when asked', async () => {
    const e = sqliteEnv();
    transcript(e, 'a', 's1', 'primary', 5, 'm1');
    transcript(e, 'b', 's2', 'primary', 5, 'm2');
    expect([...await sessionsWithTranscript(e.db, SCOPE, ['s1', 's2'], { machineId: 'm1', nonEmpty: true })]).toEqual(['s1']);
  });
});

describe('raw transcript pages', () => {
  it('lists primaries before subagent files, pages across the role boundary, and narrows to one transcript', async () => {
    const e = sqliteEnv();
    transcript(e, 'p2', 's');
    transcript(e, 'p1', 's');
    transcript(e, 'a0', 's', 'subagent');
    const first = await listTranscripts(e.db, SCOPE, 's', { limit: 2 });
    expect(first.map(row => row.transcriptId)).toEqual(['p1', 'p2', 'a0']);
    expect((await listTranscripts(e.db, SCOPE, 's', { limit: 10, transcriptId: 'p2' })).map(row => row.transcriptId)).toEqual(['p2']);
  });

  it('pages segments from the cursor and merges hot with archived in byte order', async () => {
    const e = sqliteEnv();
    transcript(e, 'p', 's');
    for (let n = 0; n < 5; n += 1) segment(e, 'p', n * 10, 10);
    const first = await pageSegments(e.db, SCOPE, 'p', { limit: 2 });
    expect(first.rows.map(row => row.baseOffset)).toEqual([0, 10]);
    const second = await pageSegments(e.db, SCOPE, 'p', { limit: 2, cursor: first.cursor! });
    expect(second.rows.map(row => row.baseOffset)).toEqual([20, 30]);
  });
});
