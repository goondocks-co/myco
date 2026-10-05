/**
 * Gate G4d: many hooks kicking at once, across projects.
 *
 * Eight sessions in two projects append fifty records each, kicking the project's helper after every append, all at
 * once. A kick that finds no helper starts one (here in this process after a start's real delay, through the same
 * lock a detached helper takes: a file lock excludes a second open of the file in one process as it does in another);
 * one that finds a helper running, or one on its way, leaves its mark. Asserts:
 * - at most one helper pass per project at any instant (a lock audit around every pass);
 * - no storm of starts while a start is under way: a handful of helpers per project, not one per kick;
 * - no wakeup lost: once every helper has exited, every record is delivered, every journal is gone and no mark is
 *   left behind;
 * - the lines of the many writers are never interleaved: every record arrives whole.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { helperPass } from '@myco/cli/member-helper.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { helperPaths, kickHelper, runHelper, type HelperRunResult } from '@myco/member/helper.js';
import { MemberSpool } from '@myco/member/spool.js';
import type { DetachedSpawn } from '@myco/runtime/spawn-detached.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { registerTestMember } from './helpers/hooks.js';

const PROJECTS = ['proj_1', 'proj_2'] as const;
const SESSIONS = 8;
const HOOKS = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const START_MS_MIN = 100;
const START_MS_MAX = 375;
/** The most helpers one project may start over the burst: one per stretch of the burst its helper was gone. */
const MAX_STARTS_PER_PROJECT = 6;

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const origErr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (() => true) as never;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

describe('many hooks kicking the helper at once (G4d)', () => {
  it(`${SESSIONS} sessions × ${HOOKS} hooks across ${PROJECTS.length} projects: one helper per project at a time, and nothing left behind`, async () => {
    const rigs = new Map<string, MemberRig>();
    for (const projectId of PROJECTS) {
      const rig = await memberRig({ projectId });
      rigs.set(projectId, rig);
      const root = fs.mkdtempSync(path.join(mycoHome, `root-${projectId}-`));
      registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId, expiresAt: rig.expiresAt, serverUrl: `https://${projectId}.test`, root });
    }

    const active = new Map<string, number>(PROJECTS.map((p) => [p, 0]));
    let overlaps = 0;
    let passes = 0;
    const runs: Array<Promise<HelperRunResult>> = [];
    const startsBy = new Map<string, number>(PROJECTS.map((p) => [p, 0]));
    const spawnFor = (projectId: string): DetachedSpawn => () => {
      startsBy.set(projectId, startsBy.get(projectId)! + 1);
      const pass = helperPass({ projectId: projectId, serverUrl: `https://${projectId}.test` }, mycoHome, { fetch: rigs.get(projectId)!.fetch });
      // A detached helper takes 100 to 375 ms to start and reach its lock (measured on the macOS VM and the Windows PC).
      runs.push(sleep(START_MS_MIN + Math.floor(Math.random() * (START_MS_MAX - START_MS_MIN))).then(() => runHelper({
        projectId, serverUrl: `https://${projectId}.test`, mycoHome, lingerMs: 40, pollMs: 5,
        pass: async (deadline, opts) => {
          const now = active.get(projectId)! + 1;
          active.set(projectId, now);
          if (now > 1) overlaps += 1;
          passes += 1;
          try { return await pass(deadline, opts); } finally { active.set(projectId, active.get(projectId)! - 1); }
        },
      })));
      return { started: true, pid: process.pid };
    };

    const kicks = { started: 0, running: 0, starting: 0 };
    const sent = new Map<string, string[]>(PROJECTS.map((p) => [p, []]));
    await Promise.all(Array.from({ length: SESSIONS }, async (_, s) => {
      const projectId = PROJECTS[s % PROJECTS.length];
      const sessionId = `sess-${s}`;
      const spool = new MemberSpool({ projectId: projectId, serverUrl: `https://${projectId}.test` }, { mycoHome });
      const ctx = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: 't' };
      for (let h = 0; h < HOOKS; h++) {
        const event = promptEvent(ctx, { promptId: mintId(), text: `${sessionId} hook ${h} ${'z'.repeat(h * 40)}` });
        sent.get(projectId)!.push(event.envelope.eventId);
        spool.append(sessionId, event);
        const outcome = kickHelper({ projectId, serverUrl: `https://${projectId}.test`, mycoHome, spawn: spawnFor(projectId) });
        if (outcome.kind === 'started') kicks.started += 1;
        else if (outcome.kind === 'running') kicks.running += 1;
        else if (outcome.kind === 'starting') kicks.starting += 1;
        // Hooks spread over about a second, so they land before, during and after a helper starts.
        await sleep(Math.floor(Math.random() * 40));
      }
    }));

    // Every helper started has exited; one started by a helper's last kick is waited for too.
    for (let settled = 0; settled < runs.length;) {
      const batch = runs.slice(settled);
      await Promise.all(batch);
      settled += batch.length;
    }

    expect(overlaps).toBe(0);
    expect(kicks.started + kicks.running + kicks.starting).toBe(SESSIONS * HOOKS);
    // Every kick while a start was under way left only its mark; the starts stay few.
    expect(kicks.starting).toBeGreaterThan(0);
    for (const projectId of PROJECTS) expect({ projectId, starts: startsBy.get(projectId)! <= MAX_STARTS_PER_PROJECT }).toEqual({ projectId, starts: true });
    // Most kicks found a helper at work or on its way.
    expect(kicks.running + kicks.starting).toBeGreaterThan(kicks.started);
    expect(passes).toBeGreaterThan(0);
    for (const projectId of PROJECTS) {
      const rig = rigs.get(projectId)!;
      const held = rig.env.sqlite.query(`SELECT event_id, payload FROM events WHERE kind = 'prompt'`).all() as Array<{ event_id: string; payload: string }>;
      expect(held.map((r) => r.event_id).sort()).toEqual([...sent.get(projectId)!].sort());
      // Every record arrived whole: its text is the one its hook wrote.
      for (const row of held) expect((JSON.parse(row.payload) as { text: string }).text).toMatch(/^sess-\d+ hook \d+ z*$/);
      const spool = new MemberSpool({ projectId: projectId, serverUrl: `https://${projectId}.test` }, { mycoHome });
      expect(spool.sessionIds()).toEqual([]);
      expect(fs.existsSync(helperPaths(projectId, mycoHome, `https://${projectId}.test`).dirty)).toBe(false);
    }
  }, 120_000);
});
