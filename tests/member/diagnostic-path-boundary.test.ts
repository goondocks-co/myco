/**
 * What the member store may reach, and what is genuinely not there.
 *
 * A member path is held inside the member root before anything is created,
 * opened or locked, so a component replaced by a link out of the root is
 * refused rather than followed. The root itself may sit under links — a home
 * under `/tmp` on macOS resolves elsewhere — so the root is resolved once and
 * only what lies beneath it is held to the rule.
 *
 * Absence is its own answer: a leaf that is not there under a directory is
 * absent, while one under an ancestor leading nowhere is a path that cannot be
 * resolved at all, which no reader may take for a file never written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertMemberPathContained, ensureMemberDir, memberRoot, pathIsAbsent, readPrivateJson } from '@myco/member/store.js';

let mycoHome: string;
let outside: string;
const temps: string[] = [];
function temp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}
beforeEach(() => {
  mycoHome = temp('myco-boundary-home-');
  outside = temp('myco-boundary-out-');
  fs.mkdirSync(path.join(memberRoot(mycoHome), 'spool'), { recursive: true });
});
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const spool = (...parts: string[]) => path.join(memberRoot(mycoHome), 'spool', ...parts);
/** Every path under `dir`, so a call that created one is visible. */
function tree(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    out.push(full);
    if (fs.lstatSync(full).isDirectory()) out.push(...tree(full));
  }
  return out.sort();
}

describe('a member path held inside the member root', () => {
  it('admits a path under the root, and a leaf not yet written', () => {
    expect(() => assertMemberPathContained(spool('proj_1'), mycoHome)).not.toThrow();
    expect(() => assertMemberPathContained(spool('proj_1', 'sess-a.jsonl'), mycoHome)).not.toThrow();
    expect(() => assertMemberPathContained(memberRoot(mycoHome), mycoHome)).not.toThrow();
  });

  it('admits a home reached through a link, as one under /tmp is', () => {
    const real = temp('myco-boundary-real-');
    const linked = path.join(temp('myco-boundary-link-'), 'home');
    fs.symlinkSync(real, linked);
    fs.mkdirSync(path.join(memberRoot(linked), 'spool'), { recursive: true });

    expect(() => assertMemberPathContained(path.join(memberRoot(linked), 'spool', 'proj_1'), linked)).not.toThrow();
    // The same directory named through what the link resolves to is the same directory.
    expect(() => assertMemberPathContained(path.join(memberRoot(real), 'spool', 'proj_1'), linked)).not.toThrow();
  });

  it('refuses a component that is a link out of the root', () => {
    fs.rmSync(spool(), { recursive: true });
    fs.symlinkSync(outside, spool());

    expect(() => assertMemberPathContained(spool('proj_1'), mycoHome)).toThrow(/out of/);
  });

  it('refuses a project directory that is a link out of the root', () => {
    fs.symlinkSync(outside, spool('proj_1'));

    expect(() => assertMemberPathContained(spool('proj_1', 'sess-a.jsonl'), mycoHome)).toThrow(/out of/);
  });

  it('refuses a component leading nowhere, rather than following it', () => {
    fs.symlinkSync(path.join(outside, 'gone'), spool('proj_1'));

    expect(() => assertMemberPathContained(spool('proj_1', 'sess-a.jsonl'), mycoHome)).toThrow(/leading nowhere/);
  });

  it('admits a link that stays inside the root', () => {
    fs.mkdirSync(spool('proj_1'));
    fs.symlinkSync(spool('proj_1'), spool('alias'));

    expect(() => assertMemberPathContained(spool('alias', 'sess-a.jsonl'), mycoHome)).not.toThrow();
  });

  it('refuses a path that leaves the root by name alone', () => {
    expect(() => assertMemberPathContained(path.join(memberRoot(mycoHome), '..', '..', 'etc'), mycoHome)).toThrow(/is outside/);
    expect(() => assertMemberPathContained(outside, mycoHome)).toThrow(/is outside/);
  });

  it('refuses a member root that is a link out of the home', () => {
    const home = temp('myco-boundary-rootlink-');
    fs.symlinkSync(outside, path.join(home, 'member'));

    expect(() => assertMemberPathContained(path.join(home, 'member', 'spool'), home)).toThrow(/out of/);
  });

  it('refuses a member root that is a link leading nowhere', () => {
    const home = temp('myco-boundary-rootgone-');
    fs.symlinkSync(path.join(outside, 'gone'), path.join(home, 'member'));

    expect(() => assertMemberPathContained(path.join(home, 'member', 'spool'), home)).toThrow(/leading nowhere/);
  });

  it('admits a member root relocated inside the home', () => {
    const home = temp('myco-boundary-relocated-');
    fs.mkdirSync(path.join(home, 'elsewhere', 'spool'), { recursive: true });
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, 'member'));

    expect(() => assertMemberPathContained(path.join(home, 'member', 'spool', 'proj_1'), home)).not.toThrow();
  });

  it('refuses a component it could not read, rather than treating it as absent', () => {
    fs.mkdirSync(spool('proj_1'));
    fs.chmodSync(spool('proj_1'), 0);
    try {
      expect(() => assertMemberPathContained(spool('proj_1', 'blobs', 'x'), mycoHome)).toThrow(/could not be read/);
    } finally {
      fs.chmodSync(spool('proj_1'), 0o700);
    }
  });

  it('creates nothing while it checks', () => {
    fs.symlinkSync(outside, spool('proj_1'));
    const before = { home: tree(mycoHome), out: tree(outside) };

    expect(() => assertMemberPathContained(spool('proj_1', 'sess-a.jsonl'), mycoHome)).toThrow();

    expect({ home: tree(mycoHome), out: tree(outside) }).toEqual(before);
  });
});

describe('the directory maker holds the same rule before it writes', () => {
  it('refuses an escaping component, leaving both sides as they were', () => {
    fs.symlinkSync(outside, spool('proj_1'));
    const before = { home: tree(mycoHome), out: tree(outside) };

    expect(() => ensureMemberDir(spool('proj_1', 'blobs'), mycoHome)).toThrow();

    expect({ home: tree(mycoHome), out: tree(outside) }).toEqual(before);
  });

  it('refuses a target named through the home\'s canonical alias, changing no mode outside', () => {
    const real = temp('myco-boundary-alias-real-');
    const linked = path.join(temp('myco-boundary-alias-link-'), 'home');
    fs.symlinkSync(real, linked);
    fs.mkdirSync(path.join(memberRoot(linked), 'spool'), { recursive: true });
    // The same directory named through what the home resolves to: a read may
    // take it, and the writer builds its levels by name, so it must not.
    const alias = path.join(memberRoot(real), 'spool', 'proj_1');
    const modes = () => tree(real).map((p) => `${p}:${(fs.lstatSync(p).mode & 0o777).toString(8)}`);
    const before = modes();

    expect(() => ensureMemberDir(alias, linked)).toThrow(/is outside/);

    expect(modes()).toEqual(before);
    expect(fs.existsSync(alias)).toBe(false);
  });

  it('still makes an ordinary member directory', () => {
    ensureMemberDir(spool('proj_1', 'blobs'), mycoHome);

    expect(fs.statSync(spool('proj_1', 'blobs')).isDirectory()).toBe(true);
    expect(fs.statSync(spool('proj_1')).mode & 0o777).toBe(0o700);
  });
});

describe('absence is told from a path that cannot be resolved', () => {
  it('reads a leaf never written under a directory as absent', () => {
    fs.mkdirSync(spool('proj_1'));

    expect(pathIsAbsent(spool('proj_1', 'sess-a.jsonl'))).toBe(true);
  });

  it('reads an entry that is there as not absent', () => {
    fs.mkdirSync(spool('proj_1'));
    fs.writeFileSync(spool('proj_1', 'sess-a.jsonl'), '', 'utf-8');

    expect(pathIsAbsent(spool('proj_1', 'sess-a.jsonl'))).toBe(false);
  });

  it('reads a link to nothing as not absent', () => {
    fs.mkdirSync(spool('proj_1'));
    fs.symlinkSync(spool('proj_1', 'gone.jsonl'), spool('proj_1', 'sess-a.jsonl'));

    expect(pathIsAbsent(spool('proj_1', 'sess-a.jsonl'))).toBe(false);
  });

  it('reads a leaf beneath an ancestor leading nowhere as not absent', () => {
    fs.symlinkSync(path.join(outside, 'gone'), spool('proj_1'));

    expect(pathIsAbsent(spool('proj_1', 'sess-a.jsonl'))).toBe(false);
  });

  it('reads a leaf beneath a file as not absent', () => {
    fs.writeFileSync(spool('proj_1'), 'not a directory', 'utf-8');

    expect(pathIsAbsent(spool('proj_1', 'sess-a.jsonl'))).toBe(false);
  });

  it('carries the distinction into the private read', () => {
    fs.mkdirSync(spool('proj_1'));
    expect(readPrivateJson(spool('proj_1', 'sess-a.json'))).toEqual({ ok: false, reason: 'missing' });

    fs.symlinkSync(path.join(outside, 'gone'), spool('proj_2'));
    expect(readPrivateJson(spool('proj_2', 'sess-a.json'))).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});
