/**
 * Gate G4d (#1561 PR 3a): many hooks kicking at once, across projects.
 *
 * Eight sessions in two projects append fifty records each, kicking the project's helper after every append, all at
 * once. A kick that finds no helper starts one (here in this process, through the same lock a detached helper takes:
 * a file lock excludes a second open of the file in one process as it does in another); one that finds a helper
 * running leaves its mark. Asserts:
 * - at most one helper pass per project at any instant (a lock audit around every pass);
 * - no wakeup lost: once every helper has exited, every record is delivered, every journal is gone and no mark is
 *   left behind;
 * - the lines of the many writers are never interleaved: every record arrives whole.
 * A repository waiting to be joined (#1547) joins this gate in PR 6.
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
    const spawnFor = (projectId: string): DetachedSpawn => () => {
      const pass = helperPass(projectId, mycoHome, { fetch: rigs.get(projectId)!.fetch });
      runs.push(runHelper({
        projectId, mycoHome, lingerMs: 40, pollMs: 5,
        pass: async (deadline) => {
          const now = active.get(projectId)! + 1;
          active.set(projectId, now);
          if (now > 1) overlaps += 1;
          passes += 1;
          try { await pass(deadline); } finally { active.set(projectId, active.get(projectId)! - 1); }
        },
      }));
      return { started: true };
    };

    const kicks = { started: 0, running: 0 };
    const sent = new Map<string, string[]>(PROJECTS.map((p) => [p, []]));
    await Promise.all(Array.from({ length: SESSIONS }, async (_, s) => {
      const projectId = PROJECTS[s % PROJECTS.length];
      const sessionId = `sess-${s}`;
      const spool = new MemberSpool(projectId, { mycoHome });
      const ctx = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: 't' };
      for (let h = 0; h < HOOKS; h++) {
        const event = promptEvent(ctx, { promptId: mintId(), text: `${sessionId} hook ${h} ${'z'.repeat(h * 40)}` });
        sent.get(projectId)!.push(event.envelope.eventId);
        spool.append(sessionId, event);
        const outcome = kickHelper({ projectId, mycoHome, spawn: spawnFor(projectId) });
        if (outcome.kind === 'started') kicks.started += 1;
        else if (outcome.kind === 'running') kicks.running += 1;
        await sleep(Math.floor(Math.random() * 4));
      }
    }));

    // Every helper started has exited; one started by a helper's last kick is waited for too.
    for (let settled = 0; settled < runs.length;) {
      const batch = runs.slice(settled);
      await Promise.all(batch);
      settled += batch.length;
    }

    expect(overlaps).toBe(0);
    expect(kicks.started + kicks.running).toBe(SESSIONS * HOOKS);
    // Most kicks found a helper at work and only left their mark.
    expect(kicks.running).toBeGreaterThan(kicks.started);
    expect(passes).toBeGreaterThan(0);
    for (const projectId of PROJECTS) {
      const rig = rigs.get(projectId)!;
      const held = rig.env.sqlite.query(`SELECT event_id, payload FROM events WHERE kind = 'prompt'`).all() as Array<{ event_id: string; payload: string }>;
      expect(held.map((r) => r.event_id).sort()).toEqual([...sent.get(projectId)!].sort());
      // Every record arrived whole: its text is the one its hook wrote.
      for (const row of held) expect((JSON.parse(row.payload) as { text: string }).text).toMatch(/^sess-\d+ hook \d+ z*$/);
      const spool = new MemberSpool(projectId, { mycoHome });
      expect(spool.sessionIds()).toEqual([]);
      expect(fs.existsSync(helperPaths(projectId, mycoHome).dirty)).toBe(false);
    }
  }, 120_000);
});
