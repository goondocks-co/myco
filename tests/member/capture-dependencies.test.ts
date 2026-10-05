import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptPhase } from '@myco/hooks/stop.js';
import type { HookRun } from '@myco/member/capture.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { readCaptureLoss } from '@myco/member/capture-loss.js';
import { planBackstop, planFileCapture } from '@myco/member/plan-files.js';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

describe('plan read dependencies survive transcript derivation', () => {
  it('ages out a confirmed missing plan, but resets confirmation after an unreadable interval', () => {
    const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-expiry-')));
    const spool = new MemberSpool({ projectId: 'proj_retry', serverUrl: 'https://example.invalid' }, { mycoHome: path.join(root, 'member-home') });
    const sessionId = 'expired-plan';
    const file = path.join(root, 'deleted.md');
    const ctx = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId) };
    const first = planFileCapture(ctx, readSessionState(spool.dir, sessionId), 'proj_retry', root, file);
    spool.appendAndRecord(sessionId, first.events, first.record);
    const old = Date.now() - 10 * 60_000;
    spool.appendAndRecord(sessionId, [], (state) => {
      state.planPaths['deleted.md'].pendingSince = old;
      state.planPaths['deleted.md'].pendingChecks = 1;
    });
    const stat = fs.statSync.bind(fs);
    const fault = spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      if (String(args[0]) === file) throw Object.assign(new Error('injected unreadable'), { code: 'EACCES' });
      return Reflect.apply(stat, fs, args);
    }) as typeof fs.statSync);
    try {
      const unreadable = planBackstop(ctx, readSessionState(spool.dir, sessionId), root);
      spool.appendAndRecord(sessionId, unreadable.events, unreadable.record);
    } finally { fault.mockRestore(); }
    expect(readSessionState(spool.dir, sessionId).planPaths['deleted.md'].pendingRead).toBe('unreadable');
    const absentAgain = planBackstop(ctx, readSessionState(spool.dir, sessionId), root);
    spool.appendAndRecord(sessionId, absentAgain.events, absentAgain.record);
    expect(readSessionState(spool.dir, sessionId).planPaths['deleted.md'].pendingRead).toBe('absent');
    spool.appendAndRecord(sessionId, [], (state) => {
      state.planPaths['deleted.md'].pendingSince = old;
      state.planPaths['deleted.md'].pendingChecks = 1;
    });
    const expired = planBackstop(ctx, readSessionState(spool.dir, sessionId), root);
    spool.appendAndRecord(sessionId, expired.events, expired.record);
    expect(readSessionState(spool.dir, sessionId).planPaths['deleted.md']).toBeUndefined();
    expect(readCaptureLoss(spool.dir)).toMatchObject({ readable: true, plans: 1 });
  });

  it('bounds outstanding plan reads by giving displaced paths a visible disposition', () => {
    const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-bound-')));
    const spool = new MemberSpool({ projectId: 'proj_retry', serverUrl: 'https://example.invalid' }, { mycoHome: path.join(root, 'member-home') });
    const sessionId = 'bounded-plans';
    spool.appendAndRecord(sessionId, [], (state) => {
      for (let i = 0; i < 1_000; i++) state.planPaths[`missing-${i}.md`] = {
        planKey: `missing-${i}`, hash: '', pendingRead: 'absent', pendingSince: i + 1, pendingChecks: 1,
      };
    });
    const ctx = { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId) };
    const capture = planFileCapture(ctx, readSessionState(spool.dir, sessionId), 'proj_retry', root, path.join(root, 'new.md'));
    spool.appendAndRecord(sessionId, capture.events, capture.record);
    const paths = readSessionState(spool.dir, sessionId).planPaths;
    expect(Object.keys(paths).filter((key) => paths[key].pendingRead !== undefined)).toHaveLength(1_000);
    expect(paths['missing-0.md']).toBeUndefined();
    expect(paths['new.md']).toBeDefined();
    expect(readCaptureLoss(spool.dir)).toMatchObject({ readable: true, plans: 1 });
  });

  for (const failure of ['ENOENT', 'EACCES', 'EIO'] as const) {
    it(`retries a first ${failure} read after the cursor advances, with unchanged transcript bytes`, () => {
      const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-retry-')));
      const file = path.join(root, '.claude/plans/first.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (failure !== 'ENOENT') fs.writeFileSync(file, '# Retry\n');
      const transcript = path.join(root, 'session.jsonl');
      fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] } }) + '\n');
      const spool = new MemberSpool({ projectId: 'proj_retry', serverUrl: 'https://example.invalid' }, { mycoHome: path.join(root, 'member-home') });
      const sessionId = 'sess-retry';
      const run: HookRun = {
        hookName: 'stop', sessionId, agent: 'claude-code', spool,
        input: { agent: 'claude-code', sessionId, transcriptPath: transcript, raw: { cwd: root } },
        credential: { source: 'registry', root, serverUrl: 'https://example.invalid', token: 'fixture-token', projectId: 'proj_retry' },
        ctx: { agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId) },
        budget: unboundedBudget(), now: Date.now, argv: [], mycoHome: path.join(root, 'member-home'), machinePlanDirs: () => [],
      };
      const read = fs.readFileSync;
      const unavailable = failure === 'ENOENT' ? null : spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === file) throw Object.assign(new Error(failure), { code: failure });
        return Reflect.apply(read, fs, args);
      }) as typeof fs.readFileSync);
      try {
        const first = transcriptPhase(run);
        expect(first.events).toEqual([]);
        spool.appendAndRecord(sessionId, first.events, first.record);
      } finally { unavailable?.mockRestore(); }
      const missed = readSessionState(spool.dir, sessionId);
      expect(missed.transcript?.parsedSize).toBe(fs.statSync(transcript).size);
      expect(missed.planPaths['.claude/plans/first.md']).toBeDefined();
      expect(missed.planPaths['.claude/plans/first.md'].pendingRead).toBe(failure === 'ENOENT' ? 'absent' : 'unreadable');
      fs.writeFileSync(file, '# Retry\n');
      const retry = transcriptPhase(run);
      expect(retry.events.map((event) => event.envelope.kind)).toEqual(['plan']);
      spool.appendAndRecord(sessionId, retry.events, retry.record);
      expect(readSessionState(spool.dir, sessionId).planPaths['.claude/plans/first.md'].pendingRead).toBeUndefined();
      expect(transcriptPhase(run).events).toEqual([]);
      expect(spool.readRecords(sessionId).filter((record) => record?.kind === 'plan')).toHaveLength(1);
    });
  }

  it('retains a first-read obligation while the path is deleted, then captures its replacement once', () => {
    const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-delete-')));
    const file = path.join(root, 'removed.md');
    const spool = new MemberSpool({ projectId: 'proj_retry', serverUrl: 'https://example.invalid' }, { mycoHome: path.join(root, 'member-home') });
    const ctx = { agent: 'claude-code', sessionId: 'deleted', stage: spool.stagerFor('deleted') };
    const capture = planFileCapture(ctx, readSessionState(spool.dir, 'deleted'), 'proj_retry', root, file, 'first-prompt');
    spool.appendAndRecord('deleted', capture.events, capture.record);
    const deleted = planBackstop(ctx, readSessionState(spool.dir, 'deleted'), root);
    spool.appendAndRecord('deleted', deleted.events, deleted.record);
    expect(deleted.events).toEqual([]);
    expect(readSessionState(spool.dir, 'deleted').planPaths['removed.md']).toBeDefined();
    fs.writeFileSync(file, '# Restored\n');
    const replacement = planBackstop(ctx, readSessionState(spool.dir, 'deleted'), root);
    expect(replacement.events).toHaveLength(1);
    expect(replacement.events[0].envelope.payload).toMatchObject({ promptId: 'first-prompt' });
    spool.appendAndRecord('deleted', replacement.events, replacement.record);
    expect(planBackstop(ctx, readSessionState(spool.dir, 'deleted'), root).events).toEqual([]);
  });

  it('preserves every outstanding read when old completed receipts are trimmed', () => {
    const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-obligations-')));
    const spool = new MemberSpool({ projectId: 'proj_retry', serverUrl: 'https://example.invalid' }, { mycoHome: root });
    spool.appendAndRecord('obligations', [], (state) => {
      for (let i = 0; i < 600; i++) {
        state.planPaths[`pending-${i}.md`] = { planKey: `pending-${i}`, hash: '', pendingRead: 'absent' };
        state.planPaths[`complete-${i}.md`] = { planKey: `complete-${i}`, hash: 'captured' };
      }
    });
    const entries = Object.values(readSessionState(spool.dir, 'obligations').planPaths);
    expect(entries.filter(entry => entry.pendingRead !== undefined)).toHaveLength(600);
    expect(entries.filter(entry => entry.pendingRead === undefined)).toHaveLength(500);
  });
});
