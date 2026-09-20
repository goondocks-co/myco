/**
 * A missed-capture record is keyed to the root it names.
 *
 * The file a root's record lives at is derived from that root, so a file whose
 * record names another one is a record for somebody else's project. A report
 * that carried it would attribute one project's lost capture to another, and a
 * report that read it as absent would say a root had never missed. Both readers
 * answer unavailable instead. The runtime readers are unchanged: they are what a
 * hook counts into and what retention removes from, and neither derives a path
 * from a record's own root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  listMissingMembershipsResult, missingMembershipPath, readMissingMembership,
  readMissingMembershipResult, recordMissingMembership, MISSING_MEMBERSHIP_VERSION,
} from '@myco/member/no-membership.js';
import { tempMycoHome } from './helpers/server.js';

const NOW = 1_800_000_000_000;
const MINE = '/home/dev/mine';
const THEIRS = '/home/dev/theirs';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
});

/** A whole record naming `root`, written into the file `at` is keyed to. */
function writeRecordAt(at: string, root: string): string {
  recordMissingMembership(at, { mycoHome, now: () => NOW, invokedBy: 'hook stop' });
  const file = missingMembershipPath(at, mycoHome);
  fs.writeFileSync(file, JSON.stringify({ version: MISSING_MEMBERSHIP_VERSION, root, count: 1, firstAt: NOW, lastAt: NOW }), { mode: 0o600 });
  return file;
}

describe('a record whose root is not the file it sits in', () => {
  it('is unavailable for the root that file belongs to, not that root\'s misses', () => {
    writeRecordAt(MINE, THEIRS);

    expect(readMissingMembershipResult(MINE, mycoHome)).toEqual({ status: 'unavailable' });
  });

  it('is counted rather than listed, so another project\'s root is never named', () => {
    writeRecordAt(MINE, THEIRS);

    const listed = listMissingMembershipsResult(mycoHome);
    expect(listed).toMatchObject({ readable: true, unavailableRecords: 1 });
    expect(listed.records).toEqual([]);
  });

  it('leaves the runtime reader alone, which reads the file it was given', () => {
    writeRecordAt(MINE, THEIRS);

    expect(readMissingMembership(MINE, mycoHome)).toMatchObject({ root: THEIRS, count: 1 });
  });

  it('is unavailable for the root it names too, whose own file holds nothing', () => {
    writeRecordAt(MINE, THEIRS);

    expect(readMissingMembershipResult(THEIRS, mycoHome)).toEqual({ status: 'missing' });
  });
});

describe('a record that names the root its file is keyed to', () => {
  it('is held, and listed', () => {
    writeRecordAt(MINE, MINE);

    expect(readMissingMembershipResult(MINE, mycoHome)).toMatchObject({ status: 'present' });
    const listed = listMissingMembershipsResult(mycoHome);
    expect(listed).toMatchObject({ readable: true, unavailableRecords: 0 });
    expect(listed.records.map((record) => record.root)).toEqual([MINE]);
  });

  it('writes nothing while a report reads it', () => {
    const file = writeRecordAt(MINE, MINE);
    const before = fs.statSync(file).mtimeMs;

    readMissingMembershipResult(MINE, mycoHome);
    listMissingMembershipsResult(mycoHome);

    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toHaveLength(1);
  });
});
