import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LegacyLedger, legacyHistoryByProject, legacySessionsToLeaveOut } from '@myco/member/legacy-ledger.js';
import { deploymentKeyFor } from '@myco/member/registry.js';

const SERVER = 'https://legacy-ledger.invalid';
const PROJECT = 'proj_ledger';
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
const fixture = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-ledger-'));
  homes.push(home);
  return { home, ledger: new LegacyLedger(home, SERVER, PROJECT) };
};

describe('legacy ledger evidence', () => {
  it('distinguishes absent, valid and unavailable evidence', () => {
    const { home, ledger } = fixture();
    expect(ledger.read()).toEqual({ ok: false, reason: 'missing' });
    expect(legacySessionsToLeaveOut(home, SERVER)).toEqual(new Set());
    ledger.append({ k: 'source', session: 'deleted-session', from: 'deleted' }, { k: 'source', session: 'vault-session', from: 'vault' });
    expect(ledger.read()).toMatchObject({ ok: true, state: { sources: new Map([['deleted-session', 'deleted'], ['vault-session', 'vault']]) } });
    expect(legacySessionsToLeaveOut(home, SERVER)).toEqual(new Set(['deleted-session', 'vault-session']));
    fs.unlinkSync(ledger.file);
    fs.mkdirSync(ledger.file);
    expect(ledger.read()).toEqual({ ok: false, reason: 'unreadable' });
    expect(() => legacySessionsToLeaveOut(home, SERVER)).toThrow('unreadable');
    expect(() => legacyHistoryByProject(home)).toThrow('unreadable');
  });

  for (const corrupt of ['{"k":"source","session":"deleted-session","from":"deleted}\n', '{"k":"source","session":"deleted-session","from":"unknown"}\n']) {
    it(`refuses corrupt committed evidence: ${corrupt.trim()}`, () => {
      const { home, ledger } = fixture();
      ledger.append({ k: 'session', session: 'accepted' });
      fs.appendFileSync(ledger.file, corrupt);
      const before = fs.readFileSync(ledger.file);
      expect(ledger.read()).toEqual({ ok: false, reason: 'invalid' });
      expect(() => ledger.readState()).toThrow('invalid');
      expect(() => legacySessionsToLeaveOut(home, SERVER)).toThrow('invalid');
      expect(() => legacyHistoryByProject(home)).toThrow('invalid');
      expect(fs.readFileSync(ledger.file)).toEqual(before);
    });
  }

  it('trims only an uncommitted trailing line before appending', () => {
    const { home, ledger } = fixture();
    ledger.append({ k: 'source', session: 'deleted-🍄', from: 'deleted' }, { k: 'session', session: 'accepted' });
    const committed = fs.readFileSync(ledger.file, 'utf8');
    fs.appendFileSync(ledger.file, '{"k":"source","session":');
    expect(legacySessionsToLeaveOut(home, SERVER)).toEqual(new Set(['deleted-🍄']));
    ledger.append({ k: 'spore', id: 'new' });
    expect(fs.readFileSync(ledger.file, 'utf8')).toBe(`${committed}{"k":"spore","id":"new"}\n`);
    expect(ledger.read()).toMatchObject({ ok: true, state: { sessions: new Set(['accepted']), spores: new Set(['new']) } });
    expect(legacyHistoryByProject(home).get(PROJECT)?.get(deploymentKeyFor(SERVER))).toEqual(new Set(['session:accepted', 'spore:new']));
  });

  it('refuses an existing ledger link whose target cannot be read', () => {
    const { home, ledger } = fixture();
    ledger.append({ k: 'source', session: 'deleted-session', from: 'deleted' });
    fs.unlinkSync(ledger.file);
    fs.symlinkSync(path.join(home, 'missing-ledger'), ledger.file);
    expect(ledger.read()).toEqual({ ok: false, reason: 'unreadable' });
    expect(() => legacySessionsToLeaveOut(home, SERVER)).toThrow('unreadable');
    expect(() => legacyHistoryByProject(home)).toThrow('unreadable');
  });

  it('refuses malformed UTF-8 in a committed session identity', () => {
    const { home, ledger } = fixture();
    ledger.append({ k: 'source', session: 'deleted-session', from: 'deleted' });
    const bytes = fs.readFileSync(ledger.file);
    bytes[bytes.indexOf('deleted-session')] = 0xff;
    fs.writeFileSync(ledger.file, bytes);
    expect(ledger.read()).toEqual({ ok: false, reason: 'invalid' });
    expect(() => ledger.readState()).toThrow('invalid');
    expect(() => legacySessionsToLeaveOut(home, SERVER)).toThrow('invalid');
    expect(() => legacyHistoryByProject(home)).toThrow('invalid');
    expect(fs.readFileSync(ledger.file)).toEqual(bytes);
  });

  for (const obstruction of ['file', 'link'] as const) it(`refuses an unavailable deployment ledger directory (${obstruction})`, () => {
    const { home, ledger } = fixture();
    ledger.append({ k: 'session', session: 'accepted' });
    const dir = path.dirname(ledger.file);
    fs.renameSync(dir, `${dir}.saved`);
    if (obstruction === 'link') fs.symlinkSync(path.join(home, 'missing-directory'), dir);
    else fs.writeFileSync(dir, 'not a directory');
    expect(() => legacySessionsToLeaveOut(home, SERVER)).toThrow();
    expect(() => legacyHistoryByProject(home)).toThrow('unreadable');
  });

  it('refuses an unavailable legacy root directory', () => {
    const { home, ledger } = fixture();
    ledger.append({ k: 'session', session: 'accepted' });
    const dir = path.dirname(path.dirname(ledger.file));
    fs.renameSync(dir, `${dir}.saved`);
    fs.symlinkSync(path.join(home, 'missing-directory'), dir);
    expect(() => legacyHistoryByProject(home)).toThrow();
    expect(() => legacySessionsToLeaveOut(home, SERVER)).toThrow();
  });

  it('does not commit a complete JSON value without its newline', () => {
    const { home, ledger } = fixture();
    ledger.append({ k: 'session', session: 'accepted' });
    fs.appendFileSync(ledger.file, '{"k":"source","session":"uncommitted","from":"vault"}');
    expect(legacySessionsToLeaveOut(home, SERVER)).toEqual(new Set());
    ledger.append({ k: 'session', session: 'new' });
    expect(legacySessionsToLeaveOut(home, SERVER)).toEqual(new Set());
    expect(legacyHistoryByProject(home).get(PROJECT)?.get(deploymentKeyFor(SERVER))).toEqual(new Set(['session:accepted', 'session:new']));
  });

  it('appends without reading the committed prefix again', () => {
    const { ledger } = fixture();
    const recordCount = 5000;
    ledger.append(...Array.from({ length: recordCount }, (_, i) => ({ k: 'spore' as const, id: `accepted-${i}` })));
    const committedLength = fs.statSync(ledger.file).size;
    const wholeReads = spyOn(fs, 'readFileSync');
    const tailReads = spyOn(fs, 'readSync');
    let readWholeLedger: boolean;
    let bytesRead: number;
    try {
      ledger.append({ k: 'spore', id: 'new' });
      readWholeLedger = wholeReads.mock.calls.some(([file]) => file === ledger.file);
      bytesRead = tailReads.mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    } finally { wholeReads.mockRestore(); tailReads.mockRestore(); }
    expect(readWholeLedger).toBe(false);
    expect(bytesRead).toBeGreaterThan(0);
    expect(bytesRead).toBeLessThan(committedLength / 2);
    expect(ledger.readState().spores.size).toBe(recordCount + 1);
  });

  it('retains a committed prefix when the torn suffix spans several read chunks', () => {
    const { ledger } = fixture();
    ledger.append({ k: 'source', session: 'deleted-🍄', from: 'deleted' });
    const committed = fs.readFileSync(ledger.file);
    const tornBytes = 20_000;
    fs.appendFileSync(ledger.file, Buffer.alloc(tornBytes, 0xff));
    ledger.append({ k: 'spore', id: 'new' });
    expect(fs.readFileSync(ledger.file)).toEqual(Buffer.concat([committed, Buffer.from('{"k":"spore","id":"new"}\n')]));
    expect(ledger.readState().sources.get('deleted-🍄')).toBe('deleted');
  });

  it('discards a wholly uncommitted file before appending', () => {
    const { ledger } = fixture();
    ledger.append({ k: 'spore', id: 'uncommitted' });
    fs.writeFileSync(ledger.file, Buffer.alloc(20_000, 0xff));
    ledger.append({ k: 'spore', id: 'new' });
    expect(fs.readFileSync(ledger.file, 'utf8')).toBe('{"k":"spore","id":"new"}\n');
    expect(ledger.readState().spores).toEqual(new Set(['new']));
  });

  it('serializes concurrent appends behind the ledger lock before trimming a torn tail', async () => {
    const { home, ledger } = fixture();
    ledger.append({ k: 'source', session: 'deleted-session', from: 'deleted' });
    fs.appendFileSync(ledger.file, '{"k":"source","session":');
    const before = fs.readFileSync(ledger.file);
    const release = path.join(home, 'release');
    const helper = path.resolve('tests/helpers/legacy-ledger-appender.ts');
    const childTimeoutMs = 10_000;
    const observationMs = 250;
    const start = (mode: 'holder' | 'writer') => {
      const child = spawn(process.execPath, ['run', helper, mode, home, SERVER, PROJECT, release], {
        cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: childTimeoutMs, killSignal: 'SIGKILL',
      });
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.includes('ready\n')) resolve(); });
        child.on('error', reject);
        child.on('close', code => { if (!stdout.includes('ready\n')) reject(new Error(`${mode} never became ready (${code}): ${stderr}`)); });
      });
      const done = new Promise<void>((resolve, reject) => {
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`${mode} failed (${code}): ${stderr}`)));
        child.on('error', reject);
      });
      return { ready, done };
    };
    const children: ReturnType<typeof start>[] = [];
    try {
      const holder = start('holder');
      children.push(holder);
      await holder.ready;
      const writer = start('writer');
      children.push(writer);
      await writer.ready;
      const completedBeforeRelease = await Promise.race([
        writer.done.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), observationMs)),
      ]);
      expect(completedBeforeRelease).toBe(false);
      expect(fs.readFileSync(ledger.file)).toEqual(before);
    } finally {
      fs.writeFileSync(release, 'release');
      await Promise.all(children.map(child => child.done));
    }
    const state = ledger.readState();
    expect(state.sources).toEqual(new Map([['deleted-session', 'deleted'], ['concurrent-deletion', 'deleted']]));
    expect(state.spores).toEqual(new Set(['concurrent-spore']));
  }, 15_000);
});
