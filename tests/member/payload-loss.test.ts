import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { unboundedBudget } from '@myco/member/budget.js';
import { REFUSAL_RETRY_INITIAL_MS } from '@myco/member/constants.js';
import { mintId, promptEvent, sessionStartEvent } from '@myco/member/envelope.js';
import { projectDiagnostics } from '@myco/member/diagnostics.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from './helpers/env-client.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { registerTestMember } from './helpers/hooks.js';
import { runStatus } from '@myco/cli/member.js';
import { CaptureLossLedger, CAPTURE_LOSS_FILE, MAX_RECENT_CAPTURE_LOSSES, recordSessionLoss } from '@myco/member/capture-loss.js';
import { updateSessionState, retireSessionFiles, readSessionState } from '@myco/member/session-state.js';

const TEXT = 'durable capture '.repeat(25_000);

describe('payload loss disposition', () => {
  it('confirms deletion across retries, sends blob_absent, delivers the tail and reports one visible loss', async () => {
    const mycoHome = tempMycoHome();
    const rig = await memberRig();
    const entry = registerTestMember({ root: '/repo-loss', serverUrl: 'https://s', token: rig.token, projectId: 'proj_1', mycoHome });
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
    const ctx = { agent: 'claude-code', sessionId: 'deleted', stage: spool.stagerFor('deleted') };
    const lost = promptEvent(ctx, { promptId: mintId(), text: TEXT });
    const tail = promptEvent(ctx, { promptId: mintId(), text: 'after missing bytes' });
    spool.appendAndRecord('deleted', [sessionStartEvent(ctx, {}), lost, tail]);
    fs.unlinkSync(lost.blobSource!.path);
    const answers: string[] = [];
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, async (input, init) => {
      const response = await rig.fetch(input, init);
      if (new URL(String(input)).pathname === '/events') {
        const body = await response.clone().json() as { code?: string };
        answers.push(body.code ?? 'acked');
      }
      return response;
    });
    const now = Date.now();
    await spool.drainSession('deleted', client, unboundedBudget(), { now: () => now });
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(spool.depth('deleted')).toBe(1);
    spool.append('deleted', promptEvent(ctx, { promptId: mintId(), text: 'fresh capture during payload backoff' }));
    await spool.drainSession('deleted', client, unboundedBudget(), { now: () => now + 1_000, honourRetry: true });
    expect(rig.rows('prompt_batches')).toBe(2);
    expect(spool.depth('deleted')).toBe(1);
    await spool.drainSession('deleted', client, unboundedBudget(), { now: () => now + 60_000 });
    expect(answers).toContain('blob_absent');
    expect(spool.depth('deleted')).toBe(0);
    expect(projectDiagnostics(entry, mycoHome, now).captureLoss).toMatchObject({ readable: true, payloads: 1, plans: 0 });
    const lines: string[] = [];
    runStatus(['--all'], { mycoHome, stdout: (line) => lines.push(line) });
    expect(lines.some((line) => line.includes('lost:') && line.includes('1 payload'))).toBe(true);
  });

  it.each(['EACCES', 'EIO'])('keeps %s bytes retryable while delivering later records', async (code) => {
    const mycoHome = tempMycoHome();
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
    const ctx = { agent: 'claude-code', sessionId: code, stage: spool.stagerFor(code) };
    const first = promptEvent(ctx, { promptId: mintId(), text: TEXT });
    spool.appendAndRecord(code, [sessionStartEvent(ctx, {}), first, promptEvent(ctx, { promptId: mintId(), text: 'healthy tail' })]);
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const read = fs.readFileSync.bind(fs);
    const fault = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === first.blobSource!.path) throw Object.assign(new Error('temporary read failure'), { code });
      return read(file, options as never);
    }) as typeof fs.readFileSync);
    try {
      await spool.drainSession(code, client, unboundedBudget());
      expect(rig.rows('prompt_batches')).toBe(1);
      expect(spool.depth(code)).toBe(1);
      await spool.drainSession(code, client, unboundedBudget(), { now: () => Date.now() + 3_600_000 });
      expect(spool.depth(code)).toBe(1);
      expect(new CaptureLossLedger(spool.dir).read().payloads).toBe(0);
    } finally { fault.mockRestore(); }
    await spool.drainSession(code, client, unboundedBudget(), { now: () => Date.now() + 7_200_000 });
    expect(spool.depth(code)).toBe(0);
    expect(rig.rows('prompt_batches')).toBe(2);
  });

  it('repairs corruption from verified source bytes without counting a loss', async () => {
    const mycoHome = tempMycoHome();
    const original = path.join(mycoHome, 'original.txt');
    fs.writeFileSync(original, TEXT);
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
    const ctx = { agent: 'claude-code', sessionId: 'repair', stage: spool.stagerFor('repair') };
    const event = promptEvent(ctx, { promptId: mintId(), text: TEXT });
    event.blobSource!.recovery = { path: original };
    fs.truncateSync(event.blobSource!.path, 1);
    spool.appendAndRecord('repair', [sessionStartEvent(ctx, {}), event]);
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await spool.drainSession('repair', client, unboundedBudget())).toMatchObject({ acked: 2, remaining: 0 });
    expect(new CaptureLossLedger(spool.dir).read().payloads).toBe(0);
    expect(rig.rows('prompt_batches')).toBe(1);
  });

  it('bounds loss accounting and preserves its count after session state retires', () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    updateSessionState(spool.dir, 'loss-count', (state) => {
      for (let i = 0; i < MAX_RECENT_CAPTURE_LOSSES + 1; i++) recordSessionLoss(state, `lost-${i}`, 'payload', Date.now());
    });
    retireSessionFiles(spool.dir, 'loss-count', () => true);
    const counts = new CaptureLossLedger(spool.dir).read();
    expect(counts.payloads).toBe(MAX_RECENT_CAPTURE_LOSSES + 1);
    expect(counts.recent).toHaveLength(MAX_RECENT_CAPTURE_LOSSES);
    expect(fs.statSync(path.join(spool.dir, CAPTURE_LOSS_FILE)).size).toBeLessThan(40_000);
    new CaptureLossLedger(spool.dir).record([{ key: `lost-${MAX_RECENT_CAPTURE_LOSSES}`, kind: 'payload', at: Date.now() }]);
    expect(new CaptureLossLedger(spool.dir).read().payloads).toBe(MAX_RECENT_CAPTURE_LOSSES + 1);
  });

  it('bounds completed migration receipts without losing their accumulated totals', () => {
    const source = new MemberSpool({ projectId: 'proj_source', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const target = new MemberSpool({ projectId: 'proj_target', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    new CaptureLossLedger(source.dir).record([{ key: 'lost-plan', kind: 'plan', at: Date.now() }]);
    const ledger = new CaptureLossLedger(target.dir);
    for (let i = 0; i <= MAX_RECENT_CAPTURE_LOSSES; i++) ledger.transferFrom(source.dir, `hold-${i}`);
    const counts = ledger.read();
    expect(counts.plans).toBe(MAX_RECENT_CAPTURE_LOSSES + 1);
    expect(counts.imports).toHaveLength(MAX_RECENT_CAPTURE_LOSSES);
    expect(fs.statSync(path.join(target.dir, CAPTURE_LOSS_FILE)).size).toBeLessThan(100_000);
  });

  it('imports only newly counted losses when a held ledger grows between migration retries', () => {
    const home = tempMycoHome();
    const held = new CaptureLossLedger(path.join(home, 'member', 'pending', 'held'));
    const live = new CaptureLossLedger(path.join(home, 'member', 'buffer', 'project'));
    fs.mkdirSync(path.join(home, 'member', 'pending', 'held'), { recursive: true });
    fs.mkdirSync(path.join(home, 'member', 'buffer', 'project'), { recursive: true });
    held.record([{ key: 'first', kind: 'plan', at: 1 }]);
    live.transferFrom(path.join(home, 'member', 'pending', 'held'), 'held-generation');
    expect(live.read().plans).toBe(1);
    held.record([{ key: 'second', kind: 'plan', at: 2 }]);
    live.transferFrom(path.join(home, 'member', 'pending', 'held'), 'held-generation');
    live.transferFrom(path.join(home, 'member', 'pending', 'held'), 'held-generation');
    expect(live.read().plans).toBe(2);
  });

  it('keeps the held record after a crash immediately following journal replacement', async () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const ctx = { agent: 'claude-code', sessionId: 'crash', stage: spool.stagerFor('crash') };
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const start = sessionStartEvent(ctx, {});
    const lost = promptEvent(ctx, { promptId: mintId(), text: TEXT });
    spool.appendAndRecord('crash', [start, lost, promptEvent(ctx, { promptId: mintId(), text: 'tail' })]);
    await client.postEvent(start.envelope, unboundedBudget());
    updateSessionState(spool.dir, 'crash', (state) => { state.highWater = 1; });
    fs.unlinkSync(lost.blobSource!.path);
    const rename = fs.renameSync.bind(fs);
    const fault = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === path.join(spool.dir, 'crash.jsonl')) throw Object.assign(new Error('crash after publication'), { code: 'EIO' });
    });
    const now = Date.now();
    try { await expect(spool.drainSession('crash', client, unboundedBudget(), { now: () => now })).rejects.toThrow('crash after publication'); }
    finally { fault.mockRestore(); }
    expect(readSessionState(spool.dir, 'crash').highWater).toBe(0);
    expect(spool.depth('crash')).toBe(1);
    await spool.drainSession('crash', client, unboundedBudget(), { now: () => now + 60_000 });
    expect(spool.depth('crash')).toBe(0);
    expect(new CaptureLossLedger(spool.dir).read().payloads).toBe(1);
    expect(rig.rows('prompt_batches')).toBe(1);
  });

  it('does not count local deletion as loss when the Deployment already has the bytes', async () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const ctx = { agent: 'claude-code', sessionId: 'already-uploaded', stage: spool.stagerFor('already-uploaded') };
    const event = promptEvent(ctx, { promptId: mintId(), text: TEXT });
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    await client.postBlob(Buffer.from(TEXT), event.blobSource!.sha256, event.blobSource!.mediaType, unboundedBudget());
    spool.appendAndRecord(ctx.sessionId, [sessionStartEvent(ctx, {}), event]);
    fs.unlinkSync(event.blobSource!.path);
    const now = Date.now();
    await spool.drainSession(ctx.sessionId, client, unboundedBudget(), { now: () => now });
    await spool.drainSession(ctx.sessionId, client, unboundedBudget(), { now: () => now + 60_000 });
    expect(spool.depth(ctx.sessionId)).toBe(0);
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(new CaptureLossLedger(spool.dir).read().payloads).toBe(0);
  });

  it('preserves a later server refusal window when local payload retries are compacted', async () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const ctx = { agent: 'claude-code', sessionId: 'two-waits', stage: spool.stagerFor('two-waits') };
    const missing = promptEvent(ctx, { promptId: mintId(), text: TEXT });
    const refused = promptEvent(ctx, { promptId: mintId(), text: 'future event' });
    refused.envelope.kind = 'future.kind' as never;
    spool.appendAndRecord(ctx.sessionId, [sessionStartEvent(ctx, {}), missing, refused]);
    fs.unlinkSync(missing.blobSource!.path);
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await spool.drainSession(ctx.sessionId, client, unboundedBudget())).toMatchObject({ endedBy: 'refused', remaining: 2 });
    expect(readSessionState(spool.dir, ctx.sessionId).eventRetry).toMatchObject({ backoffMs: REFUSAL_RETRY_INITIAL_MS });
    expect(readSessionState(spool.dir, ctx.sessionId).eventRetry?.localPayload).toBeUndefined();
  });
});
