/**
 * `myco member drain [--all]` runs the one drain implementation unbounded and
 * ignoring the latch; `myco member status` prints the entry with the token
 * redacted, expiry, spool depth, last ack/refusal, and the latch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import path from 'node:path';
import { mintId, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { run as runMemberCli } from '@myco/cli/member.js';
import { MEMBER_HELP } from '@myco/cli/member.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { registerTestMember } from './helpers/hooks.js';

let mycoHome: string;
let rig: MemberRig;
const savedHome = process.env.MYCO_HOME;
const origErr = process.stderr.write.bind(process.stderr);
beforeEach(async () => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (() => true) as never;
  rig = await memberRig();
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const ctxFor = (spool: MemberSpool, sessionId: string): EnvelopeContext => ({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' });

describe('myco member drain / status', () => {
  it('drain delivers every spooled event for the current project, ignoring the latch; status reports the redacted entry and an empty spool afterwards', async () => {
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
    const spool = new MemberSpool('proj_1', { mycoHome });
    for (let i = 0; i < 4; i++) spool.append('sess-cli', promptEvent(ctxFor(spool, 'sess-cli'), { promptId: mintId(), text: `p${i}` }));
    spool.markOffline(Date.now());
    const out: string[] = [];
    const err: string[] = [];
    await runMemberCli(['status'], { mycoHome, fetch: rig.fetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    const status = out.join('\n');
    expect(status).toContain('project:    proj_1');
    expect(status).not.toContain(rig.token);
    expect(status).toContain(`token:      ${rig.token.slice(0, 4)}…${rig.token.slice(-4)} (${rig.tokenId})`);
    expect(status).toContain('sess-cli — 4 un-acknowledged');
    expect(status).toContain('latch:      offline since');
    expect(status).toContain('refused:    0 logged');

    out.length = 0;
    await runMemberCli(['drain'], { mycoHome, fetch: rig.fetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(out.join('\n')).toContain('proj_1 sess-cli: sent 4, acked 4, refused 0, remaining 0');
    expect(rig.rows('events')).toBe(4);
    expect(spool.readLatch()).toBeNull();

    out.length = 0;
    await runMemberCli(['status'], { mycoHome, fetch: rig.fetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(out.join('\n')).toContain('spool:      0 session file(s), 0 un-acknowledged event(s)');
    expect(out.join('\n')).toContain('latch:      online');
    expect(err).toEqual([]);
  });

  it('--all walks every registry entry; without an entry for the cwd the op says so and does nothing', async () => {
    const out: string[] = [];
    const err: string[] = [];
    await runMemberCli(['drain'], { mycoHome, fetch: rig.fetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(err.join('\n')).toContain('no registry entry');
    expect(out).toEqual([]);
    const other = await rig.otherMachine();
    registerTestMember({ mycoHome, token: other.token, tokenId: other.tokenId, projectId: 'proj_1', root: path.join(mycoHome, 'elsewhere') });
    const spool = new MemberSpool('proj_1', { mycoHome });
    spool.append('sess-all', promptEvent(ctxFor(spool, 'sess-all'), { promptId: mintId(), text: 'x' }));
    await runMemberCli(['drain', '--all'], { mycoHome, fetch: rig.fetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(out.join('\n')).toContain('proj_1 sess-all: sent 1, acked 1');
    expect(rig.rows('events')).toBe(1);
  });

  it('an unknown op prints the help and sets a non-zero exit code', async () => {
    const err: string[] = [];
    await runMemberCli(['frobnicate'], { mycoHome, stderr: (l) => err.push(l) });
    expect(err.join('\n')).toContain(MEMBER_HELP.trim().split('\n')[0]);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });
});
