import { afterEach, describe, expect, it } from 'bun:test';
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
      expect(() => legacySessionsToLeaveOut(home, SERVER)).toThrow('invalid');
      expect(() => legacyHistoryByProject(home)).toThrow('invalid');
      expect(() => ledger.append({ k: 'session', session: 'new' })).toThrow('invalid');
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
    expect(() => legacySessionsToLeaveOut(home, SERVER)).toThrow('invalid');
    expect(() => legacyHistoryByProject(home)).toThrow('invalid');
    expect(() => ledger.append({ k: 'session', session: 'new' })).toThrow('invalid');
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
});
