/**
 * The Deployment's side of a replaced transcript. The member detects a file
 * rewritten in place by its head before it ships; this is the other path — a
 * pointer whose digest the Deployment disagrees with — answered
 * `transcript_replaced`. The member re-mints the pointer over the bytes the
 * file holds now and ships them as a transcript of their own, once; a second
 * disagreement under the fresh id is a refusal like any other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unboundedBudget } from '@myco/member/budget.js';
import { TRANSCRIPT_HEAD_HASH_BYTES } from '@myco/member/constants.js';
import type { EnvelopeContext, MemberEnvelope } from '@myco/member/envelope.js';
import { readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { shipTranscriptSegments, transcriptPointerFor } from '@myco/member/transcript.js';
import type { Outcome, ServerClient } from '@myco/member/transport.js';
import { tempMycoHome } from './helpers/server.js';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => { process.env.MYCO_HOME = savedHome; });

const SESSION = 'sess-remint';
const MACHINE = 'machine_1';

/** A Deployment that holds a different head for the member's id, then accepts what follows. */
function disagreeingClient(answers: Outcome[]): { client: ServerClient; posted: MemberEnvelope[] } {
  const posted: MemberEnvelope[] = [];
  const client = {
    postBlob: async (): Promise<Outcome> => ({ class: 'acked', body: {} }),
    postEvent: async (envelope: MemberEnvelope): Promise<Outcome> => {
      posted.push(envelope);
      return answers.shift() ?? { class: 'acked', body: {}, transcript: { size: envelope.payload.baseOffset as number + (envelope.payload.length as number), segmentCount: posted.length } };
    },
  } as unknown as ServerClient;
  return { client, posted };
}

describe('a transcript the Deployment reports replaced', () => {
  it('is re-minted over the file\'s current bytes and shipped again from offset zero under a new id, once', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remint-')), `${SESSION}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(TRANSCRIPT_HEAD_HASH_BYTES) } }) + '\n');
    const fresh = transcriptPointerFor(file, MACHINE)!;
    // The pointer the member holds was minted over a head the file no longer has; the Deployment holds that head too.
    const stale = { ...fresh, transcriptId: `tx_${'0'.repeat(32)}`, headHash: 'f'.repeat(64) };
    updateSessionState(spool.dir, SESSION, (s) => { s.transcript = stale; });
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId: SESSION, stage: spool.stagerFor(SESSION), version: 'test' };
    const { client, posted } = disagreeingClient([{ class: 'refused', code: 'transcript_replaced', reason: 'transcript was replaced under the same identity' }]);

    const result = await shipTranscriptSegments(ctx, spool, client, unboundedBudget(), { machineId: MACHINE });

    expect(result).toEqual({ shipped: 1, endedBy: 'done' });
    expect(posted.map((e) => e.payload.transcriptId)).toEqual([stale.transcriptId, fresh.transcriptId]);
    expect(posted[1].payload.baseOffset).toBe(0);
    expect(posted[1].payload.headHash).toBe(fresh.headHash);
    const pointer = readSessionState(spool.dir, SESSION).transcript!;
    expect([pointer.transcriptId, pointer.nextOffset]).toEqual([fresh.transcriptId, fs.statSync(file).size]);
    // Nothing was refused: the replacement is a new transcript, not a lost segment.
    expect(spool.readRefused()).toEqual([]);
  });

  it('refuses a second disagreement under the fresh id rather than re-minting forever', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remint-')), `${SESSION}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'y'.repeat(TRANSCRIPT_HEAD_HASH_BYTES) } }) + '\n');
    const fresh = transcriptPointerFor(file, MACHINE)!;
    updateSessionState(spool.dir, SESSION, (s) => { s.transcript = { ...fresh, transcriptId: `tx_${'1'.repeat(32)}`, headHash: 'e'.repeat(64) }; });
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId: SESSION, stage: spool.stagerFor(SESSION), version: 'test' };
    const refusal: Outcome = { class: 'refused', code: 'transcript_replaced', reason: 'transcript was replaced under the same identity' };
    const { client, posted } = disagreeingClient([refusal, refusal]);

    const result = await shipTranscriptSegments(ctx, spool, client, unboundedBudget(), { machineId: MACHINE });

    expect(result.endedBy).toBe('refused');
    expect(posted).toHaveLength(2);
    expect(spool.readRefused().map((r) => r.code)).toEqual(['transcript_replaced']);
  });

  it('never re-mints a pointer whose file is too short for a digest: the same bytes mint the same id', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remint-')), `${SESSION}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'short' } }) + '\n');
    const pointer = transcriptPointerFor(file, MACHINE)!;
    updateSessionState(spool.dir, SESSION, (s) => { s.transcript = pointer; });
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId: SESSION, stage: spool.stagerFor(SESSION), version: 'test' };
    const { client, posted } = disagreeingClient([{ class: 'refused', code: 'transcript_replaced', reason: 'transcript was replaced under the same identity' }]);

    const result = await shipTranscriptSegments(ctx, spool, client, unboundedBudget(), { machineId: MACHINE });

    expect(result.endedBy).toBe('refused');
    expect(posted).toHaveLength(1);
    expect(readSessionState(spool.dir, SESSION).transcript?.transcriptId).toBe(pointer.transcriptId);
  });
});
