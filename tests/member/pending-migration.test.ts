import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mintId, promptEvent, responseEvent, sessionStartEvent } from '@myco/member/envelope.js';
import { CAPTURE_LOSS_FILE, CaptureLossLedger, readCaptureLoss } from '@myco/member/capture-loss.js';
import { appendPending, expirePending, flushPending, PENDING_TTL_MS, pendingDir, pendingSpool } from '@myco/member/pending.js';
import { readRegistryEntry, REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { drainEntryBacklog } from '@myco/member/backlog.js';
import { readSessionState, updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from './helpers/env-client.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { memberRig, tempMycoHome } from './helpers/server.js';

const LARGE = 'held prompt'.repeat(40_000);

function fixture() {
  const mycoHome = tempMycoHome();
  const repo = { root: path.join(mycoHome, 'repo'), rootKey: 'd'.repeat(32), serverUrl: 'https://s' };
  fs.mkdirSync(repo.root);
  const opts = { mycoHome, now: Date.now() };
  const held = pendingSpool(repo, opts)!;
  const live = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
  const context = (sessionId: string) => ({ agent: 'claude-code', sessionId, stage: held.stagerFor(sessionId), now: () => opts.now });
  return { mycoHome, repo, opts, held, live, context };
}

function join(f: ReturnType<typeof fixture>, token = 'fixture-token') {
  writeRegistryEntry({ version: REGISTRY_VERSION, root: f.repo.root, projectId: 'proj_1', serverUrl: 'https://s', token, machineId: 'machine_1', joinedAt: f.opts.now, updatedAt: f.opts.now }, { mycoHome: f.mycoHome });
}

describe('pending migration', () => {
  it('moves a missing held payload and later records with their receipts into live delivery', () => {
    const f = fixture();
    const missing = promptEvent(f.context('missing'), { promptId: mintId(), text: LARGE });
    appendPending(f.repo, 'missing', [missing], (state) => { state.prompts.receipt = 'id'; }, f.opts);
    fs.unlinkSync(missing.blobSource!.path);
    const later = promptEvent(f.context('later'), { promptId: mintId(), text: LARGE + ' later' });
    appendPending(f.repo, 'later', [later], (state) => { state.prompts.later = 'later-id'; }, f.opts);

    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(2);
    expect(f.live.readRecords('missing').map((line) => line?.eventId)).toEqual([missing.envelope.eventId]);
    expect(f.live.readRecords('later').map((line) => line?.eventId)).toEqual([later.envelope.eventId]);
    expect(readSessionState(f.live.dir, 'missing').prompts.receipt).toBe('id');
    expect(readSessionState(f.live.dir, 'later').prompts.later).toBe('later-id');
    expect(f.live.readRecords('missing')[0]?._blobSource?.path).toBe(missing.blobSource!.path);
    expect(fs.readFileSync(f.live.readRecords('later')[0]!._blobSource!.path, 'utf8')).toBe(LARGE + ' later');
  });

  it('precedes a new same-session response with its held prompt and deduplicates a replay', () => {
    const f = fixture();
    const promptId = mintId();
    const old = promptEvent(f.context('ordered'), { promptId, text: 'before' });
    appendPending(f.repo, 'ordered', [old], undefined, f.opts);
    const fresh = responseEvent({ agent: 'claude-code', sessionId: 'ordered', stage: f.live.stagerFor('ordered'), now: () => f.opts.now + 1 },
      { promptId, text: 'after' });
    f.live.append('ordered', fresh);
    expect(f.live.readRecords('ordered').map((record) => record?.kind)).toEqual(['response']);
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(1);
    expect(f.live.readRecords('ordered').map((record) => record?.kind)).toEqual(['prompt', 'response']);
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(0);
    expect(f.live.readRecords('ordered').map((record) => record?.eventId)).toEqual([old.envelope.eventId, fresh.envelope.eventId]);
  });

  it('delivers the healthy tail during a transient held-blob read failure, then restores the blob', async () => {
    const f = fixture();
    const old = promptEvent(f.context('transient'), { promptId: mintId(), text: LARGE });
    const tail = sessionStartEvent(f.context('transient'), { startedAt: f.opts.now + 1, originPath: f.repo.root });
    appendPending(f.repo, 'transient', [old, tail], undefined, f.opts);
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(2);
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const read = fs.readFileSync.bind(fs);
    const fault = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === old.blobSource!.path) throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      return Reflect.apply(read, fs, args);
    }) as typeof fs.readFileSync);
    try {
      expect(await f.live.drainSession('transient', client, unboundedBudget(), { now: () => f.opts.now })).toMatchObject({ acked: 1, remaining: 1 });
      expect(rig.rows('events')).toBe(1);
    } finally { fault.mockRestore(); }
    expect(await f.live.drainSession('transient', client, unboundedBudget(), { now: () => f.opts.now + 60_000 })).toMatchObject({ acked: 1, remaining: 0 });
    expect(rig.rows('events')).toBe(2);
    expect(readCaptureLoss(f.live.dir)).toMatchObject({ readable: true, payloads: 0 });
  });

  it('moves later sessions when one pending journal cannot be read, and routes joined capture to live', () => {
    const f = fixture();
    const old = sessionStartEvent(f.context('unreadable'), { startedAt: f.opts.now, originPath: f.repo.root });
    const later = sessionStartEvent(f.context('later'), { startedAt: f.opts.now, originPath: f.repo.root });
    appendPending(f.repo, 'unreadable', [old], undefined, f.opts);
    appendPending(f.repo, 'later', [later], undefined, f.opts);
    join(f);
    const read = fs.readFileSync.bind(fs);
    const fault = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === path.join(pendingDir(f.repo.rootKey, f.mycoHome, 'https://s'), 'unreadable.jsonl')) throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      return Reflect.apply(read, fs, args);
    }) as typeof fs.readFileSync);
    try {
      expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(1);
      const fresh = sessionStartEvent(f.context('fresh'), { startedAt: f.opts.now, originPath: f.repo.root });
      expect(appendPending(f.repo, 'fresh', [fresh], undefined, f.opts)).toBe('project');
      expect(f.live.readRecords('fresh').map((line) => line?.eventId)).toEqual([fresh.envelope.eventId]);
      expect(f.held.readRecords('fresh')).toEqual([]);
    } finally { fault.mockRestore(); }
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(1);
    expect(f.live.readRecords('unreadable').map((line) => line?.eventId)).toEqual([old.envelope.eventId]);
  });

  it('keeps the helper draining live events when held cleanup fails', async () => {
    const f = fixture();
    const old = sessionStartEvent(f.context('held-helper'), { startedAt: f.opts.now, originPath: f.repo.root });
    appendPending(f.repo, 'held-helper', [old], undefined, f.opts);
    const live = sessionStartEvent({ agent: 'claude-code', sessionId: 'live-helper', stage: f.live.stagerFor('live-helper'), now: () => f.opts.now },
      { startedAt: f.opts.now, originPath: f.repo.root });
    f.live.append('live-helper', live);
    const rig = await memberRig();
    join(f, rig.token);
    const remove = fs.rmSync.bind(fs);
    const fault = spyOn(fs, 'rmSync').mockImplementation(((file: fs.PathLike, options?: fs.RmOptions) => {
      if (String(file) === path.join(f.held.dir, 'pending.json')) throw Object.assign(new Error('injected cleanup failure'), { code: 'EIO' });
      return remove(file, options);
    }) as typeof fs.rmSync);
    try {
      const entry = readRegistryEntry(f.repo.root, f.mycoHome)!;
      const report = await drainEntryBacklog(entry, { mycoHome: f.mycoHome, fetch: rig.fetch, now: () => f.opts.now, machineId: 'machine_1' });
      expect(report.endedBy).toBe('done');
      expect(rig.env.sqlite.query(`SELECT session_id FROM events`).all()).toEqual(expect.arrayContaining([{ session_id: 'live-helper' }]));
      expect(fs.existsSync(path.join(f.held.dir, 'pending.json'))).toBe(true);
    } finally { fault.mockRestore(); }
  });

  it('stops a held migration at its helper deadline and resumes the remaining sessions later', () => {
    const f = fixture();
    for (const sessionId of ['first', 'second']) {
      appendPending(f.repo, sessionId, [sessionStartEvent(f.context(sessionId), { startedAt: f.opts.now, originPath: f.repo.root })], undefined, f.opts);
    }
    expect(flushPending(f.repo.rootKey, f.live, { ...f.opts, deadline: Date.now() - 1 })).toBe(0);
    expect(f.live.sessionIds()).toEqual([]);
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(2);
  });

  it('leaves held migration for the next helper when a pending writer owns the repository lock', () => {
    const f = fixture();
    appendPending(f.repo, 'busy', [sessionStartEvent(f.context('busy'), { startedAt: f.opts.now, originPath: f.repo.root })], undefined, f.opts);
    const taken = LifecycleLock.acquire(path.join(f.mycoHome, 'member', 'pending', `.${f.repo.rootKey}.lock`), { command: 'test pending writer' });
    if (!taken.acquired) throw new Error('failed to acquire pending writer fixture');
    try {
      expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(0);
      expect(f.held.readRecords('busy')).toHaveLength(1);
    } finally { taken.lock.release(); }
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(1);
  });

  it('appends joined capture while the pending migration owns the repository lock', () => {
    const f = fixture();
    join(f);
    const taken = LifecycleLock.acquire(path.join(f.mycoHome, 'member', 'pending', `.${f.repo.rootKey}.lock`), { command: 'test pending migration' });
    if (!taken.acquired) throw new Error('failed to acquire pending migration fixture');
    try {
      const source = new URL('../../packages/myco/src/member/pending.ts', import.meta.url).href;
      const code = `import { appendPending } from ${JSON.stringify(source)}; process.stdout.write(appendPending(${JSON.stringify(f.repo)}, 'joined-busy', [], undefined, ${JSON.stringify(f.opts)}));`;
      const child = spawnSync(process.execPath, ['-e', code], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 5_000 });
      expect({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }).toEqual({ status: 0, signal: null, stdout: 'project', stderr: '' });
    } finally { taken.lock.release(); }
  });

  it('moves readable records around a damaged pending line and counts that line as lost', () => {
    const f = fixture();
    const before = sessionStartEvent(f.context('damaged'), { startedAt: f.opts.now, originPath: f.repo.root });
    const after = sessionStartEvent(f.context('damaged'), { startedAt: f.opts.now + 1, originPath: f.repo.root });
    appendPending(f.repo, 'damaged', [before], undefined, f.opts);
    fs.appendFileSync(path.join(pendingDir(f.repo.rootKey, f.mycoHome, 'https://s'), 'damaged.jsonl'), '{broken}\n');
    appendPending(f.repo, 'damaged', [after], undefined, f.opts);
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(2);
    expect(f.live.readRecords('damaged').map((line) => line?.eventId)).toEqual([before.envelope.eventId, after.envelope.eventId]);
    expect(readCaptureLoss(f.live.dir)).toMatchObject({ readable: true, records: 1 });
    expect(fs.existsSync(path.join(pendingDir(f.repo.rootKey, f.mycoHome, 'https://s'), 'damaged.jsonl'))).toBe(false);
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(0);
    expect(f.live.readRecords('damaged')).toHaveLength(2);
    expect(readCaptureLoss(f.live.dir)).toMatchObject({ readable: true, records: 1 });
  });

  it('keeps live referenced pending bytes past TTL, then reclaims them after acknowledgement', () => {
    const f = fixture();
    const event = promptEvent(f.context('referenced'), { promptId: mintId(), text: LARGE });
    appendPending(f.repo, 'referenced', [event], undefined, f.opts);
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(1);
    expect(expirePending(f.repo.rootKey, { mycoHome: f.mycoHome, serverUrl: 'https://s', now: f.opts.now + 2 * PENDING_TTL_MS })).toBe(false);
    expect(fs.existsSync(event.blobSource!.path)).toBe(true);
    updateSessionState(f.live.dir, 'referenced', (state) => { state.highWater = 1; }, f.opts.now);
    expect(expirePending(f.repo.rootKey, { mycoHome: f.mycoHome, serverUrl: 'https://s', now: f.opts.now + 2 * PENDING_TTL_MS })).toBe(true);
  });

  it('carries held capture-loss totals into the joined project before retiring pending metadata', () => {
    const f = fixture();
    const event = sessionStartEvent(f.context('lost-plan'), { startedAt: f.opts.now, originPath: f.repo.root });
    appendPending(f.repo, 'lost-plan', [event], undefined, f.opts);
    new CaptureLossLedger(f.held.dir).record([{ key: 'plan-confirmed-deleted', kind: 'plan', at: f.opts.now }]);
    expect(readCaptureLoss(f.held.dir)).toMatchObject({ readable: true, plans: 1 });

    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(1);
    expect(readCaptureLoss(f.live.dir)).toMatchObject({ readable: true, plans: 1 });
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(0);
    expect(readCaptureLoss(f.live.dir)).toMatchObject({ readable: true, plans: 1 });
    expect(fs.existsSync(path.join(f.held.dir, CAPTURE_LOSS_FILE))).toBe(false);
  });

  it('does not count a held loss twice when cleanup stops after the ledger transfer', () => {
    const f = fixture();
    const event = sessionStartEvent(f.context('retry-ledger'), { startedAt: f.opts.now, originPath: f.repo.root });
    appendPending(f.repo, 'retry-ledger', [event], undefined, f.opts);
    new CaptureLossLedger(f.held.dir).record([{ key: 'plan-confirmed-deleted', kind: 'plan', at: f.opts.now }]);
    const remove = fs.rmSync.bind(fs);
    const fault = spyOn(fs, 'rmSync').mockImplementation(((file: fs.PathLike, options?: fs.RmOptions) => {
      if (String(file) === path.join(f.held.dir, 'pending.json')) throw Object.assign(new Error('injected cleanup failure'), { code: 'EIO' });
      return remove(file, options);
    }) as typeof fs.rmSync);
    try { expect(() => flushPending(f.repo.rootKey, f.live, f.opts)).toThrow('injected cleanup failure'); }
    finally { fault.mockRestore(); }
    expect(readCaptureLoss(f.live.dir)).toMatchObject({ readable: true, plans: 1 });
    expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(0);
    expect(readCaptureLoss(f.live.dir)).toMatchObject({ readable: true, plans: 1 });
  });

  it('counts separate pending holds for the same repository even at the same clock instant', () => {
    const f = fixture();
    for (const sessionId of ['first-hold', 'second-hold']) {
      const event = sessionStartEvent(f.context(sessionId), { startedAt: f.opts.now, originPath: f.repo.root });
      appendPending(f.repo, sessionId, [event], undefined, f.opts);
      new CaptureLossLedger(f.held.dir).record([{ key: 'same-plan-loss-key', kind: 'plan', at: f.opts.now }]);
      expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(1);
    }
    expect(readCaptureLoss(f.live.dir)).toMatchObject({ readable: true, plans: 2 });
  });

  it('preserves an unreadable held loss ledger while moving readable capture', () => {
    const f = fixture();
    const event = sessionStartEvent(f.context('ledger-bad'), { startedAt: f.opts.now, originPath: f.repo.root });
    appendPending(f.repo, 'ledger-bad', [event], undefined, f.opts);
    fs.writeFileSync(path.join(f.held.dir, CAPTURE_LOSS_FILE), '{broken');
    const diagnostic = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(flushPending(f.repo.rootKey, f.live, f.opts)).toBe(1);
      expect(f.live.readRecords('ledger-bad').map((line) => line?.eventId)).toEqual([event.envelope.eventId]);
      expect(fs.existsSync(path.join(f.held.dir, CAPTURE_LOSS_FILE))).toBe(true);
      expect(fs.existsSync(path.join(f.held.dir, 'pending.json'))).toBe(true);
      expect(diagnostic).toHaveBeenCalled();
    } finally { diagnostic.mockRestore(); }
  });
});
