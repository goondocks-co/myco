import { describe, expect, it, spyOn } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unboundedBudget } from '@myco/member/budget.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { appendPending, flushPending, pendingDir, pendingSpool } from '@myco/member/pending.js';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from '@myco/member/transport.js';
import { memberRig, tempMycoHome } from './helpers/server.js';

const LARGE = 'capture'.repeat(50_000);
const context = (spool: MemberSpool, sessionId: string) => ({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' });

describe('staged capture durability', () => {
  it('repairs a torn content-addressed object before returning its reference and accepts the capture once', async () => {
    const mycoHome = tempMycoHome();
    const spool = new MemberSpool('proj_1', { mycoHome });
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
    const spool = new MemberSpool('proj_1', { mycoHome: tempMycoHome() });
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
    const spool = new MemberSpool('proj_1', { mycoHome: tempMycoHome() });
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
    const spool = new MemberSpool('proj_1', { mycoHome: tempMycoHome() });
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

  it('concurrent identical stagers and readers observe only complete final objects', async () => {
    const mycoHome = tempMycoHome();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const bytes = Buffer.from(LARGE);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(spool.blobsDirFor('race'), digest);
    const modulePath = path.resolve('packages/myco/src/member/spool.ts');
    const script = `import {MemberSpool} from ${JSON.stringify(modulePath)}; const stage = new MemberSpool('proj_1',{mycoHome:process.argv[1]}).stagerFor('race'); for(let i=0;i<15;i++) stage(Buffer.from('capture'.repeat(50000)),'text/plain');`;
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
    const repo = { root: path.join(mycoHome, 'repo'), rootKey: 'c'.repeat(32) };
    const opts = { mycoHome, now: Date.now() };
    const source = pendingSpool(repo, opts)!;
    const event = promptEvent(context(source, 'replay'), { promptId: mintId(), text: LARGE });
    appendPending(repo, 'replay', [event], (state) => { state.prompts.receipt = 'id'; }, opts);
    const target = new MemberSpool('proj_1', { mycoHome });
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
    it(`pending migration retains capture and receipts on ${code}, then retries without new input`, async () => {
      const mycoHome = tempMycoHome();
      const repo = { root: path.join(mycoHome, 'repo'), rootKey: 'a'.repeat(32) };
      const opts = { mycoHome, now: Date.now() };
      const source = pendingSpool(repo, opts)!;
      const event = promptEvent(context(source, 'pending'), { promptId: mintId(), text: LARGE });
      appendPending(repo, 'pending', [event], (state) => { state.prompts.receipt = 'prompt-id'; }, opts);
      const target = new MemberSpool('proj_1', { mycoHome });
      const read = fs.readFileSync.bind(fs);
      const fault = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === event.blobSource!.path) throw Object.assign(new Error('injected read failure'), { code });
        return Reflect.apply(read, fs, args);
      }) as typeof fs.readFileSync);
      try {
        expect(flushPending(repo.rootKey, target, opts)).toBe(0);
        expect(source.readRecords('pending')).toHaveLength(1);
        expect(readSessionState(target.dir, 'pending').prompts.receipt).toBeUndefined();
        expect(fs.existsSync(path.join(pendingDir(repo.rootKey, mycoHome), 'pending.json'))).toBe(true);
      } finally { fault.mockRestore(); }
      expect(flushPending(repo.rootKey, target, opts)).toBe(1);
      expect(flushPending(repo.rootKey, target, opts)).toBe(0);
      expect(target.readRecords('pending')).toHaveLength(1);
      expect(readSessionState(target.dir, 'pending').prompts.receipt).toBe('prompt-id');
      const rig = await memberRig();
      const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
      expect(await target.drainSession('pending', client, unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
    });
  }

  it('reports genuinely missing pending bytes and preserves their journal and receipt for recovery', () => {
    const mycoHome = tempMycoHome();
    const repo = { root: path.join(mycoHome, 'repo'), rootKey: 'b'.repeat(32) };
    const opts = { mycoHome, now: Date.now() };
    const source = pendingSpool(repo, opts)!;
    const event = promptEvent(context(source, 'missing'), { promptId: mintId(), text: LARGE });
    appendPending(repo, 'missing', [event], (state) => { state.prompts.receipt = 'id'; }, opts);
    fs.unlinkSync(event.blobSource!.path);
    const lines: string[] = [];
    const diagnostic = spyOn(process.stderr, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      expect(flushPending(repo.rootKey, new MemberSpool('proj_1', { mycoHome }), opts)).toBe(0);
      expect(source.readRecords('missing')).toHaveLength(1);
      expect(readSessionState(source.dir, 'missing').prompts.receipt).toBe('id');
      expect(lines.join('')).toContain('missing');
      expect(lines.join('')).toContain('kept');
    } finally { diagnostic.mockRestore(); }
  });
});
