/**
 * A latch a report cannot render still holds the member off.
 *
 * The offline latch decides whether a hook may dial. A shape the read refuses
 * is a latch removed, and a removed latch dials — so the shape must stay what
 * the runtime has always taken, three numbers, and nothing narrower. `1e309`
 * parses to Infinity, which is a number: the member keeps holding off, and it
 * is the report that calls the latch unreadable, where rejecting it costs
 * nothing but a rendered line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MemberSpool } from '@myco/member/spool.js';
import { projectDiagnostics } from '@myco/member/diagnostics.js';
import { writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { tempMycoHome } from './helpers/server.js';

const NOW = 1_800_000_000_000;
const ROOT = '/home/dev/acme-web';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
});

const entry = (): RegistryEntry => ({
  version: 2, projectId: 'proj_1', serverUrl: 'https://deployment.example', token: 'mt_thisisaverysecrettokenvalue',
  tokenId: 'mt_abc123', memberId: 'mem_dev', machineId: 'dev-laptop', root: ROOT, joinedAt: NOW, updatedAt: NOW,
});

/** Writes the latch file as the raw JSON given, since `JSON.stringify` turns Infinity into null. */
function writeLatch(spool: MemberSpool, json: string): void {
  fs.writeFileSync(path.join(spool.dir, 'offline.json'), json, { mode: 0o600 });
}

describe('a latch carrying a number no report can render', () => {
  it('still holds the member off, so nothing dials while it stands', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    writeLatch(spool, `{"since":${NOW},"nextProbeAt":1e309,"backoffMs":30000}`);

    expect(spool.readLatch()).toMatchObject({ since: NOW, nextProbeAt: Infinity });
    expect(spool.shouldDial(NOW)).toBe(false);
    expect(spool.shouldDial(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('is what the report calls unreadable, which costs only a rendered line', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    writeLatch(spool, `{"since":${NOW},"nextProbeAt":1e309,"backoffMs":30000}`);

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.latchReadable).toBe(false);
    expect(facts.latch).toBeNull();
  });

  it('dials once a probe time it can compare has come', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    writeLatch(spool, `{"since":${NOW},"nextProbeAt":${NOW + 30_000},"backoffMs":30000}`);

    expect(spool.shouldDial(NOW)).toBe(false);
    expect(spool.shouldDial(NOW + 30_000)).toBe(true);
  });
});

describe('a latch the read refuses outright', () => {
  it('is one no field is a number in, and the member dials as it does with none', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    writeLatch(spool, '{"since":"soon","nextProbeAt":"later","backoffMs":"a while"}');

    expect(spool.readLatch()).toBeNull();
    expect(spool.shouldDial(NOW)).toBe(true);
  });

  it('reads an absent latch as the member being online', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });

    expect(spool.readLatch()).toBeNull();
    expect(spool.shouldDial(NOW)).toBe(true);
    expect(spool.readLatchResult()).toEqual({ readable: true, latch: null });
  });
});
