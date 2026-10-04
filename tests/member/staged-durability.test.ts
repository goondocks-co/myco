import { describe, expect, it, spyOn } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unboundedBudget } from '@myco/member/budget.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { appendPending, appendPendingTurnEnd, expirePending, flushPending, PENDING_TTL_MS, pendingSpool } from '@myco/member/pending.js';
import { registryEntryPath, REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from '@myco/member/transport.js';
import { memberRig, tempMycoHome } from './helpers/server.js';

const LARGE = 'capture'.repeat(50_000);
const context = (spool: MemberSpool, sessionId: string) => ({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' });

describe('staged capture durability', () => {
  it('repairs a torn content-addressed object before returning its reference and accepts the capture once', async () => {
    const mycoHome = tempMycoHome();
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
    const ctx = context(spool, 'torn');
    const first = promptEvent(ctx, { promptId: mintId(), text: LARGE });
    fs.truncateSync(first.blobSource!.path, 1);
    const next = promptEvent(ctx, { promptId: mintId(), text: LARGE });
    expect(fs.readFileSync(next.blobSource!.path, 'utf8')).toBe(LARGE);
    spool.append('torn', next);
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await spool.drainSession('torn', client, unboundedBudget())).toMatchObject({ acked: 1, refused: 0, remaining: 0 });
    expect(rig.rows('events')).toBe(1);
  });

  it('a partial staging write never publishes partial final bytes and a retry repairs it', () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const stage = spool.stagerFor('fault');
    const bytes = Buffer.from(LARGE);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const final = path.join(spool.blobsDirFor('fault'), digest);
    const write = fs.writeFileSync.bind(fs);
    let failed = false;
    const fault = spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (!failed && data instanceof Uint8Array && data.byteLength === bytes.byteLength) {
        failed = true;
        write(file, data.subarray(0, 1), options);
        throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
      }
      return write(file, data, options);
    });
    try {
      expect(() => stage(bytes, 'text/plain')).toThrow('injected write failure');
      expect(fs.existsSync(final)).toBe(false);
    } finally { fault.mockRestore(); }
    expect(fs.readFileSync(stage(bytes, 'text/plain').path)).toEqual(bytes);
  });

  it('holds corrupt local bytes before a terminal server digest refusal can consume the receipt', async () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const event = promptEvent(context(spool, 'corrupt'), { promptId: mintId(), text: LARGE });
    spool.append('corrupt', event);
    fs.truncateSync(event.blobSource!.path, 1);
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await spool.drainSession('corrupt', client, unboundedBudget())).toMatchObject({ refused: 0, remaining: 1, endedBy: 'unreadable' });
    spool.stagerFor('corrupt')(Buffer.from(LARGE), event.blobSource!.mediaType);
    expect(await spool.drainSession('corrupt', client, unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
  });

  it('publishes new complete objects through rename without writing the final name', () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const bytes = Buffer.from(LARGE);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const final = path.join(spool.blobsDirFor('publication'), digest);
    const write = fs.writeFileSync.bind(fs);
    const publications: string[] = [];
    const observing = spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file) === final) publications.push('final-write');
      return write(file, data, options);
    });
    try {
      expect(spool.stagerFor('publication')(bytes, 'text/plain').path).toBe(final);
      expect(publications).toEqual([]);
      expect(fs.readFileSync(final)).toEqual(bytes);
    } finally { observing.mockRestore(); }
  });

  it('syncs the staged file and its directory before publishing its final name', () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const bytes = Buffer.from(LARGE);
    const dir = spool.blobsDirFor('sync-order');
    const final = path.join(dir, crypto.createHash('sha256').update(bytes).digest('hex'));
    const open = fs.openSync.bind(fs);
    const sync = fs.fsyncSync.bind(fs);
    const rename = fs.renameSync.bind(fs);
    const paths = new Map<number, string>();
    const order: string[] = [];
    const opening = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = open(file, flags, mode);
      paths.set(fd, String(file));
      return fd;
    }) as typeof fs.openSync);
    const syncing = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      const file = paths.get(fd);
      if (file?.startsWith(dir)) order.push(file === dir ? 'directory-sync' : 'file-sync');
      return sync(fd);
    });
    const renaming = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === final) order.push('publish');
      return rename(from, to);
    });
    try {
      expect(spool.stagerFor('sync-order')(bytes, 'text/plain').path).toBe(final);
      expect(order.slice(0, 3)).toEqual(['file-sync', 'directory-sync', 'publish']);
    } finally {
      opening.mockRestore(); syncing.mockRestore(); renaming.mockRestore();
    }
  });

  it('publishes when file flushing requires a writable handle', () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const open = fs.openSync.bind(fs);
    const sync = fs.fsyncSync.bind(fs);
    const readonly = new Set<number>();
    const opening = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = open(file, flags, mode);
      if (String(file).endsWith('.tmp')) {
        readonly.delete(fd);
        if (flags === 'r') readonly.add(fd);
      }
      return fd;
    }) as typeof fs.openSync);
    const syncing = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (readonly.has(fd)) throw Object.assign(new Error('flush requires write access'), { code: 'EACCES' });
      sync(fd);
    });
    try {
      const source = spool.stagerFor('writable-flush')(Buffer.from(LARGE), 'text/plain');
      expect(fs.readFileSync(source.path, 'utf8')).toBe(LARGE);
    } finally { syncing.mockRestore(); opening.mockRestore(); }
  });

  it('does not publish a staged blob when its file sync fails', () => {
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome: tempMycoHome() });
    const bytes = Buffer.from(LARGE);
    const final = path.join(spool.blobsDirFor('sync-failure'), crypto.createHash('sha256').update(bytes).digest('hex'));
    const syncing = spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('injected sync failure'), { code: 'EIO' });
    });
    try {
      expect(() => spool.stagerFor('sync-failure')(bytes, 'text/plain')).toThrow('injected sync failure');
      expect(fs.existsSync(final)).toBe(false);
    } finally { syncing.mockRestore(); }
  });

  it('concurrent identical stagers and readers observe only complete final objects', async () => {
    const mycoHome = tempMycoHome();
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
    const bytes = Buffer.from(LARGE);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(spool.blobsDirFor('race'), digest);
    const modulePath = path.resolve('packages/myco/src/member/spool.ts');
    const script = `import {MemberSpool} from ${JSON.stringify(modulePath)}; const stage = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' },{mycoHome:process.argv[1]}).stagerFor('race'); for(let i=0;i<15;i++) stage(Buffer.from('capture'.repeat(50000)),'text/plain');`;
    const observed: string[] = [];
    const reader = setInterval(() => {
      try { observed.push(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') observed.push('read-error'); }
    }, 1);
    try {
      await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--no-env-file', '-e', script, mycoHome], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      })));
    } finally { clearInterval(reader); }
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set([digest]));
  });

  it('an interrupted pending move can replay the same envelopes without duplicating the target journal', () => {
    const mycoHome = tempMycoHome();
    const repo = { root: path.join(mycoHome, 'repo'), rootKey: 'c'.repeat(32), serverUrl: 'https://s' };
    const opts = { mycoHome, now: Date.now() };
    const source = pendingSpool(repo, opts)!;
    const event = promptEvent(context(source, 'replay'), { promptId: mintId(), text: LARGE });
    appendPending(repo, 'replay', [event], (state) => { state.prompts.receipt = 'id'; }, opts);
    const target = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
    const interrupt = spyOn(target, 'appendMovedTurnEnds').mockImplementation(() => { throw new Error('interrupted move'); });
    try { expect(() => flushPending(repo.rootKey, target, opts)).toThrow('interrupted move'); }
    finally { interrupt.mockRestore(); }
    expect(source.readRecords('replay')).toHaveLength(1);
    expect(target.readRecords('replay')).toHaveLength(1);
    expect(flushPending(repo.rootKey, target, opts)).toBe(1);
    expect(target.readRecords('replay')).toHaveLength(1);
    expect(readSessionState(target.dir, 'replay').prompts.receipt).toBe('id');
  });

  for (const code of ['EACCES', 'EIO', 'ENOENT']) {
    it(`pending migration transfers the source and receipts across ${code}, then delivers when readable`, async () => {
      const mycoHome = tempMycoHome();
      const repo = { root: path.join(mycoHome, 'repo'), rootKey: 'a'.repeat(32), serverUrl: 'https://s' };
      const opts = { mycoHome, now: Date.now() };
      const source = pendingSpool(repo, opts)!;
      const event = promptEvent(context(source, 'pending'), { promptId: mintId(), text: LARGE });
      appendPending(repo, 'pending', [event], (state) => { state.prompts.receipt = 'prompt-id'; }, opts);
      const target = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
      const read = fs.readFileSync.bind(fs);
      const fault = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === event.blobSource!.path) throw Object.assign(new Error('injected read failure'), { code });
        return Reflect.apply(read, fs, args);
      }) as typeof fs.readFileSync);
      try {
        expect(flushPending(repo.rootKey, target, opts)).toBe(1);
        expect(source.readRecords('pending')).toHaveLength(0);
        expect(target.readRecords('pending')[0]?._blobSource?.path).toBe(event.blobSource!.path);
        expect(readSessionState(target.dir, 'pending').prompts.receipt).toBe('prompt-id');
      } finally { fault.mockRestore(); }
      expect(flushPending(repo.rootKey, target, opts)).toBe(0);
      expect(target.readRecords('pending')).toHaveLength(1);
      expect(readSessionState(target.dir, 'pending').prompts.receipt).toBe('prompt-id');
      const rig = await memberRig();
      const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
      expect(await target.drainSession('pending', client, unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
    });
  }

  it('moves missing pending bytes with their journal and receipt for live disposition', () => {
    const mycoHome = tempMycoHome();
    const repo = { root: path.join(mycoHome, 'repo'), rootKey: 'b'.repeat(32), serverUrl: 'https://s' };
    const opts = { mycoHome, now: Date.now() };
    const source = pendingSpool(repo, opts)!;
    const event = promptEvent(context(source, 'missing'), { promptId: mintId(), text: LARGE });
    appendPending(repo, 'missing', [event], (state) => { state.prompts.receipt = 'id'; }, opts);
    fs.unlinkSync(event.blobSource!.path);
    const target = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
    expect(flushPending(repo.rootKey, target, opts)).toBe(1);
    expect(fs.existsSync(path.join(source.dir, 'missing.jsonl'))).toBe(false);
    expect(target.readRecords('missing')[0]?._blobSource?.path).toBe(event.blobSource!.path);
    expect(readSessionState(target.dir, 'missing').prompts.receipt).toBe('id');
  });

  it('new capture and turn marks enter the live spool while a held blob read fails', () => {
    const mycoHome = tempMycoHome();
    const repo = { root: path.join(mycoHome, 'repo'), rootKey: 'd'.repeat(32), serverUrl: 'https://s' };
    fs.mkdirSync(repo.root);
    const opts = { mycoHome, now: Date.now() };
    const source = pendingSpool(repo, opts)!;
    const old = promptEvent(context(source, 'ordered'), { promptId: mintId(), text: LARGE });
    const fresh = promptEvent(context(source, 'ordered'), { promptId: mintId(), text: 'new capture' });
    appendPending(repo, 'ordered', [old], undefined, opts);
    writeRegistryEntry({ version: REGISTRY_VERSION, root: repo.root, projectId: 'proj_1', serverUrl: 'https://s', token: 'fixture-token', machineId: 'machine_1', joinedAt: opts.now, updatedAt: opts.now }, { mycoHome });
    const read = fs.readFileSync.bind(fs);
    let registryUnavailable = false;
    const fault = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === old.blobSource!.path) throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      if (registryUnavailable && String(args[0]) === registryEntryPath(repo.root, mycoHome)) throw Object.assign(new Error('injected registry failure'), { code: 'EACCES' });
      return Reflect.apply(read, fs, args);
    }) as typeof fs.readFileSync);
    const mark = { slot: 'primary' as const, transcriptId: 'tx_1234', atSize: 10 };
    const target = new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://s' }, { mycoHome });
    try {
      expect(appendPending(repo, 'ordered', [fresh], undefined, opts)).toBe('project');
      expect(appendPendingTurnEnd(repo, 'ordered', mark, undefined, opts)).toBe('project');
      expect(target.readRecords('ordered')).toHaveLength(1);
      expect(target.pendingTurnEnds('ordered')).toHaveLength(1);
      expect(expirePending(repo.rootKey, { mycoHome, now: opts.now + 2 * PENDING_TTL_MS })).toBe(false);
      registryUnavailable = true;
      expect(expirePending(repo.rootKey, { mycoHome, now: opts.now + 2 * PENDING_TTL_MS })).toBe(false);
      expect(source.readRecords('ordered')).toHaveLength(1);
    } finally { fault.mockRestore(); }
    expect(flushPending(repo.rootKey, target, opts)).toBe(1);
    expect(target.readRecords('ordered').map((line) => line?.eventId)).toEqual([old.envelope.eventId, fresh.envelope.eventId]);
    expect(target.pendingTurnEnds('ordered')).toHaveLength(1);
  });
});
