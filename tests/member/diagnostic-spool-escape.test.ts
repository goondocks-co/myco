/**
 * A report reads the spool where it is, and nothing else.
 *
 * The spool's own directory, a session's lock, its records, its state, the
 * offline latch and the refusal log are all paths a crafted or broken layout
 * can point out of the member root. A report answers `readable: false` for
 * each of them, before it opens or locks anything, and the directory it would
 * have reached keeps its contents, its modes and its absence of a lock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemberSpool, OFFLINE_LATCH_FILE, REFUSED_LOG_FILE } from '@myco/member/spool.js';
import { tempMycoHome } from './helpers/server.js';

let mycoHome: string;
let spoolRoot: string;
let outside: string;
const savedHome = process.env.MYCO_HOME;
const temps: string[] = [];

beforeEach(() => {
  mycoHome = tempMycoHome();
  temps.push(mycoHome);
  process.env.MYCO_HOME = mycoHome;
  spoolRoot = path.join(mycoHome, 'member', 'spool');
  fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-outside-')));
  temps.push(outside);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Every entry under `dir` with its mode and its bytes, read without following links. */
function snapshot(dir: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    const mode = (stat.mode & 0o777).toString(8);
    if (stat.isDirectory()) {
      out.push([name, mode, 'dir']);
      out.push(...snapshot(full).map(([child, m, body]): [string, string, string] => [path.join(name, child), m, body]));
    } else if (stat.isSymbolicLink()) out.push([name, mode, `link:${fs.readlinkSync(full)}`]);
    else out.push([name, mode, fs.readFileSync(full, 'utf-8')]);
  }
  return out;
}

/** A report's spool: built without making its directories, as `projectDiagnostics` builds it. */
const reportSpool = (): MemberSpool => new MemberSpool('proj_1', { mycoHome, initialize: false });

describe('a spool directory that leads outside the member root', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(outside, 'secrets.jsonl'), '{"eventId":"e1"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(outside, OFFLINE_LATCH_FILE), '{"since":1,"nextProbeAt":2,"backoffMs":3}', { mode: 0o600 });
    fs.writeFileSync(path.join(outside, REFUSED_LOG_FILE), '{"eventId":"e1","sessionId":"s1","kind":"k","code":"refused","reason":"r","at":1}\n', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(spoolRoot, 'proj_1'));
  });

  it('is unreadable to a report, at every path the report would read', () => {
    const spool = reportSpool();

    expect(spool.readSpool()).toEqual({ readable: false, sessions: [] });
    expect(spool.stateSessionIds()).toEqual([]);
    expect(spool.readRecordsOrNull('secrets')).toEqual({ readable: false });
    expect(spool.readAck('secrets')).toEqual({ readable: false });
    expect(spool.readRefused()).toEqual({ entries: [], unreadableLines: 0, readable: false });
    expect(spool.readLatchResult().readable).toBe(false);
    expect(spool.readLatch()).toBeNull();
  });

  it('keeps its contents, its modes and its freedom from locks while a report reads', () => {
    const before = snapshot(outside);
    const spool = reportSpool();

    spool.readSpool();
    spool.stateSessionIds();
    spool.readRecordsOrNull('secrets');
    spool.readAck('secrets');
    spool.readRefused();
    spool.readLatchResult();

    expect(snapshot(outside)).toEqual(before);
  });
});

describe('one path inside the spool leading outside it', () => {
  let dir: string;
  let target: string;
  beforeEach(() => {
    dir = path.join(spoolRoot, 'proj_1');
    fs.mkdirSync(dir, { mode: 0o700 });
    target = path.join(outside, 'target');
    fs.writeFileSync(target, 'untouched\n', { mode: 0o600 });
  });

  it('reports the session rather than reading the file its record path points at', () => {
    fs.writeFileSync(target, '{"eventId":"e1"}\n{"eventId":"e2"}\n', { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, 's1.jsonl'));
    const before = snapshot(outside);

    expect(reportSpool().readRecordsOrNull('s1')).toEqual({ readable: false });
    // The listing names it, so the spool is readable and that one session is not.
    expect(reportSpool().readSpool()).toEqual({ readable: true, sessions: [{ sessionId: 's1', unacknowledged: null }] });
    expect(snapshot(outside)).toEqual(before);
  });

  it('takes no lock on a file outside, and reads no records under one', () => {
    fs.writeFileSync(path.join(dir, 's1.jsonl'), '{"eventId":"e1"}\n', { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, '.s1.lock'));
    const before = snapshot(outside);

    expect(reportSpool().readRecordsOrNull('s1')).toEqual({ readable: false });
    expect(reportSpool().readSpool()).toEqual({ readable: true, sessions: [{ sessionId: 's1', unacknowledged: null }] });
    expect(snapshot(outside)).toEqual(before);
    expect(fs.readFileSync(target, 'utf-8')).toBe('untouched\n');
  });

  it('answers for a state file that leads outside rather than acknowledging from it', () => {
    fs.writeFileSync(target, JSON.stringify({ version: 1, highWater: 9, prompts: {}, lastAckAt: 1_800_000_000_000 }), { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, 's1.state.json'));
    const before = snapshot(outside);

    expect(reportSpool().readAck('s1')).toEqual({ readable: false });
    expect(snapshot(outside)).toEqual(before);
  });

  it('answers for a latch and a refusal log that lead outside', () => {
    fs.writeFileSync(target, JSON.stringify({ since: 1, nextProbeAt: 2, backoffMs: 3 }), { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, OFFLINE_LATCH_FILE));
    fs.symlinkSync(target, path.join(dir, REFUSED_LOG_FILE));
    const before = snapshot(outside);

    expect(reportSpool().readLatchResult().readable).toBe(false);
    expect(reportSpool().readRefused()).toEqual({ entries: [], unreadableLines: 0, readable: false });
    expect(snapshot(outside)).toEqual(before);
  });
});

describe('a spool file the listing named and the read did not find', () => {
  it('is a session the read lost, not an empty one', () => {
    fs.mkdirSync(path.join(spoolRoot, 'proj_1'), { mode: 0o700 });

    expect(reportSpool().readRecordsOrNull('never-written')).toEqual({ readable: false });
  });
});

describe('a spool root that is not a directory', () => {
  beforeEach(() => {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
    fs.writeFileSync(spoolRoot, 'not a directory\n', { mode: 0o600 });
  });

  it('is unavailable to a report, which neither throws nor reads it as empty', () => {
    const spool = reportSpool();

    expect(spool.readSpool()).toEqual({ readable: false, sessions: [] });
    expect(spool.stateSessionIds()).toEqual([]);
    expect(spool.readAck('s1')).toEqual({ readable: false });
    expect(spool.readRefused()).toEqual({ entries: [], unreadableLines: 0, readable: false });
    // The path is refused for a reason of its own; the report says only that it could not be used.
    expect(spool.readLatchResult()).toEqual({ readable: false, reason: 'unreadable', detail: 'path unavailable' });
  });
});

describe('a spool directory that leads nowhere', () => {
  it('is unreadable, rather than a spool a member has not written yet', () => {
    fs.symlinkSync(path.join(spoolRoot, 'gone'), path.join(spoolRoot, 'proj_1'));

    expect(reportSpool().readSpool()).toEqual({ readable: false, sessions: [] });
  });

  it('is empty only where nothing is there at all', () => {
    expect(reportSpool().readSpool()).toEqual({ readable: true, sessions: [] });
  });
});

describe('the refusal log', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(spoolRoot, 'proj_1');
    fs.mkdirSync(dir, { mode: 0o700 });
  });

  it('is no refusals only where it is genuinely not there', () => {
    expect(reportSpool().readRefused()).toEqual({ entries: [], unreadableLines: 0, readable: true });
  });

  it('is unreadable where it leads nowhere', () => {
    fs.symlinkSync(path.join(dir, 'gone.jsonl'), path.join(dir, REFUSED_LOG_FILE));

    expect(reportSpool().readRefused()).toEqual({ entries: [], unreadableLines: 0, readable: false });
  });

  it('is unreadable where it is a directory, rather than a log with nothing in it', () => {
    fs.mkdirSync(path.join(dir, REFUSED_LOG_FILE), { mode: 0o700 });

    expect(reportSpool().readRefused()).toEqual({ entries: [], unreadableLines: 0, readable: false });
  });
});
