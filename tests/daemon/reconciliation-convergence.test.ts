import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession, nowSec } from '../helpers/sessions.js';
import { createReconciler } from '@myco/daemon/reconciliation.js';
import { EventDedupCache } from '@myco/daemon/event-dedup-cache.js';
import {
  handleUserPrompt,
  handleToolUse,
  handleToolFailure,
  handleSubagentStop,
  handleStopBatches,
  TOOL_INPUT_STORE_LIMIT,
} from '@myco/daemon/event-handlers.js';
import { listBatchesBySession, insertBatchStateless } from '@myco/db/queries/batches.js';
import { listActivities, countActivities } from '@myco/db/queries/activities.js';
import { getDatabase } from '@myco/db/client.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Content-keyed convergence: the reconciler matches buffer events against
// stored rows by content fingerprint instead of comparing prompt counts.
// These tests cover the shapes the count-based pass got wrong — duplicate
// hook copies of already-processed events, torn buffer lines, miner-rewritten
// prompt text, and missed activities with no prompt divergence at all.

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function makeWarnLogger() {
  const warns: string[] = [];
  const logger = {
    debug: () => {}, info: () => {}, error: () => {},
    warn: (_kind: string, msg: string) => { warns.push(msg); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { logger, warns };
}

describe('Buffer reconciliation — content-keyed convergence', () => {
  let tmpDir: string;
  let bufferDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-converge-'));
    bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function bufferPathFor(sessionId: string): string {
    return path.join(bufferDir, `${sessionId}.jsonl`);
  }

  function writeBuffer(sessionId: string, lines: Array<Record<string, unknown> | string>): void {
    const content = lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .join('\n') + '\n';
    fs.writeFileSync(bufferPathFor(sessionId), content);
  }

  /** Push a buffer file's mtime into the past so it counts as idle. */
  function ageBuffer(sessionId: string, ageMs: number): void {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(bufferPathFor(sessionId), past, past);
  }

  function makeReconciler(logger = silentLogger, eventDedupCache?: EventDedupCache) {
    return createReconciler({
      bufferDirs: [bufferDir],
      logger,
      projectRoot: process.cwd(),
      eventDedupCache,
    });
  }

  /**
   * Backdate a batch so the stop-replay freshness guard sees it as STALE
   * (missed-Stop shape: open, with its last sign of life in the past).
   */
  function backdateBatch(batchId: number, ageSeconds: number): void {
    const past = nowSec() - ageSeconds;
    getDatabase().prepare(
      `UPDATE prompt_batches SET created_at = ?, started_at = ? WHERE id = ?`,
    ).run(past, past, batchId);
  }

  // Shape 1: the live path already processed the prompt (row in DB), but the
  // buffer holds BOTH the daemon-appended copy and the hook CLI's duplicate
  // copy. The count-based pass saw 1 DB batch vs 2 buffered human prompts
  // and replayed the "extra" one as a duplicate.
  it('converges a DB-present prompt against daemon copy + hook duplicate copy — and stays converged on the reload path', () => {
    const sessionId = 'conv-n-plus-1';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'fix the auth bug', { kind: 'initial' });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'fix the auth bug', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'user_prompt', prompt: 'fix the auth bug', origin: 'human', timestamp: '2026-06-10T10:00:00.007Z' },
    ]);

    const reconciler = makeReconciler();
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);

    // Reload path: clearSession (unregister) wipes the once-per-lifetime
    // mark; a second full pass must converge to the same single batch.
    reconciler.clearSession(sessionId);
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  // Shape 2: the hook's 2s response timeout makes it append its own copy a
  // couple of seconds after the daemon already appended (and processed) the
  // event. Same convergence outcome at a wider gap inside the dedup window.
  it('converges the 2s-timeout shape (daemon copy + late hook copy, row in DB)', () => {
    const sessionId = 'conv-timeout';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'run the migration', { kind: 'initial' });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'run the migration', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'user_prompt', prompt: 'run the migration', origin: 'human', timestamp: '2026-06-10T10:00:02.100Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  // Shape 10: a torn line in the MIDDLE of an idle file is permanent damage
  // — excluded with one warning, everything else converges, and the session
  // is marked reconciled (converge-with-loss).
  it('excludes a torn middle line on an idle file, warns once per lifetime, and converges the rest', () => {
    const sessionId = 'conv-torn-middle';
    seedSession({ id: sessionId });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'first prompt', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      '{"type":"user_prompt","prompt":"torn-in-ha',
      { type: 'user_prompt', prompt: 'second prompt', origin: 'human', timestamp: '2026-06-10T10:01:00.000Z' },
    ]);
    ageBuffer(sessionId, 60_000);

    const { logger, warns } = makeWarnLogger();
    const reconciler = makeReconciler(logger);
    reconciler.reconcileSession(sessionId);

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.user_prompt)).toEqual(['first prompt', 'second prompt']);
    const tornWarns = () => warns.filter((m) => m.includes('unparseable')).length;
    expect(tornWarns()).toBe(1);

    // Session was marked reconciled: an immediate re-trigger is a no-op.
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);

    // The warn is once per session per daemon lifetime — even a forced
    // second pass (reload path) stays quiet about the same torn line.
    reconciler.clearSession(sessionId);
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);
    expect(tornWarns()).toBe(1);
  });

  // Shape 11: a torn TAIL on a fresh file is most likely an append still in
  // flight — the pass aborts without replaying and the session stays
  // eligible; once the file is idle it converges with the tear excluded.
  it('aborts on a torn tail while the file is fresh, then converges once idle', () => {
    const sessionId = 'conv-torn-tail';
    seedSession({ id: sessionId });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'complete prompt', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      '{"type":"user_prompt","prompt":"still being writ',
    ]);

    const reconciler = makeReconciler();
    // File mtime is "now" → fresh → abort, nothing replayed, not marked.
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);

    // File goes idle → the tear is permanent; converge what parses.
    ageBuffer(sessionId, 60_000);
    reconciler.reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('complete prompt');
  });

  // Shape 12: a buffer that accumulated lines across the origin-forwarding
  // upgrade boundary. Pre-rule lines (no origin) re-gate through the
  // manifest; agent-less tool lines replay under the default symbiont;
  // post-rule lines keep their forwarded origin verbatim.
  it('replays a mixed-shape file: pre-rule re-gating, agent-less defaults, forwarded origins', () => {
    const sessionId = 'conv-mixed';
    seedSession({ id: sessionId, agent: 'claude-code' });

    writeBuffer(sessionId, [
      // Pre-rule human prompt — re-gates to origin=human.
      { type: 'user_prompt', agent: 'claude-code', prompt: 'do the thing', timestamp: '2026-06-10T10:00:00.000Z' },
      // Agent-less tool line — replays under DEFAULT_SYMBIONT_NAME.
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'pwd' }, timestamp: '2026-06-10T10:00:01.000Z' },
      // Pre-rule task-notification — manifest re-gates to origin=system.
      { type: 'user_prompt', agent: 'claude-code', prompt: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>', timestamp: '2026-06-10T10:00:20.000Z' },
      // Pre-rule command dispatch — manifest DROPS it (never a batch).
      { type: 'user_prompt', agent: 'claude-code', prompt: '<command-name>/compact</command-name>', timestamp: '2026-06-10T10:00:30.000Z' },
      // Post-rule teammate message — forwarded origin wins, no re-gating.
      { type: 'user_prompt', prompt: '<teammate-message teammate_id="researcher">found it</teammate-message>', origin: 'agent_dispatch', timestamp: '2026-06-10T10:00:40.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(3);
    const byPrompt = new Map(batches.map((b) => [b.user_prompt, b.origin]));
    expect(byPrompt.get('do the thing')).toBe('human');
    expect([...byPrompt.entries()].find(([p]) => p?.startsWith('<task-notification>'))?.[1]).toBe('system');
    expect([...byPrompt.entries()].find(([p]) => p?.startsWith('<teammate-message '))?.[1]).toBe('agent_dispatch');
    expect(batches.some((b) => b.user_prompt?.startsWith('<command-name>'))).toBe(false);
    expect(countActivities(sessionId)).toBe(1);
  });

  // Shape 13: the Stop-time transcript miner stored a different rendering of
  // a LONG prompt than the hook buffered (tail rewrite). Exact keys diverge;
  // the second-chance prefix match converges instead of duplicating. The
  // match requires BOTH texts to span the full 60-char window and agree
  // across it — anything shorter is covered by the exact key alone.
  const LONG_BASE = 'Investigate the intermittent capture pipeline regression in the daemon'; // > 60 chars

  it('second-chance prefix match: long buffered text whose stored row gained a rewritten tail converges', () => {
    const sessionId = 'conv-miner-prefix-a';
    seedSession({ id: sessionId });
    const now = nowSec();
    insertBatchStateless({
      session_id: sessionId,
      user_prompt: `${LONG_BASE} and write a postmortem when done`,
      started_at: now,
      ended_at: now,
      created_at: now,
    });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: LONG_BASE, origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  it('second-chance prefix match: long buffered text with a rewritten tail converges onto the stored row', () => {
    const sessionId = 'conv-miner-prefix-b';
    seedSession({ id: sessionId });
    const now = nowSec();
    insertBatchStateless({
      session_id: sessionId,
      user_prompt: LONG_BASE,
      started_at: now,
      ended_at: now,
      created_at: now,
    });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: `${LONG_BASE} and watch for restart loops`, origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  // Short prompts never take the second chance: a repeated short prompt
  // ("continue", "y") whose first occurrence is in the DB but whose second
  // occurrence was missed must REPLAY — the exact key already covers short
  // texts completely, so a key miss means a genuine new turn.
  it('a genuine repeated short prompt — one in DB, one only buffered — replays instead of prefix-matching', () => {
    const sessionId = 'conv-short-repeat';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'continue', { kind: 'initial' });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'continue', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      // 40 minutes later, outside the dedup window: a genuine second turn
      // the daemon missed.
      { type: 'user_prompt', prompt: 'continue', origin: 'human', timestamp: '2026-06-10T10:40:00.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);
  });

  // The convergence lookup keys user_prompt events on the candidate replay
  // text. A pre-rule buffered event carrying a rewrite-rule preamble (Codex
  // desktop file-mention wrapper) exact-matches the row the live hook
  // stored (rewritten), without leaning on the prefix path.
  it('a rewrite-rule prompt exact-matches the stored rewritten row via its candidate text', () => {
    const sessionId = 'conv-rewrite-key';
    seedSession({ id: sessionId, agent: 'codex' });
    handleUserPrompt(sessionId, 'please resize the screenshot', { kind: 'initial' });

    writeBuffer(sessionId, [
      {
        type: 'user_prompt',
        agent: 'codex',
        prompt: '# Files mentioned by the user:\n## shot.png: /tmp/shot.png\n## My request for Codex:\nplease resize the screenshot',
        timestamp: '2026-06-10T10:00:00.000Z',
      },
    ]);

    makeReconciler().reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('please resize the screenshot');
  });

  // Shape 14 (P1 scope): the staleness-qualified open-batch guard. A FRESH
  // open batch may be a live turn — the replayed stop skips it. A STALE open
  // batch is the missed-Stop shape itself (the Stop is what closes batches)
  // and its buffered summary is recovered, without closing the batch. Closed
  // batches with a NULL summary always take the summary.
  it('replayed stop skips a FRESH open batch', () => {
    const sessionId = 'conv-stop-fresh-open';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'hello', { kind: 'initial' });
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'hello', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'stop', last_assistant_message: 'should not land', timestamp: '2026-06-10T10:00:05.000Z' },
    ]);
    makeReconciler().reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].ended_at).toBeNull();
    expect(batches[0].response_summary).toBeNull();
  });

  it('replayed stop treats an old batch with RECENT activity as fresh — a long live turn is protected', () => {
    const sessionId = 'conv-stop-long-turn';
    seedSession({ id: sessionId });
    const { batchId } = handleUserPrompt(sessionId, 'hello', { kind: 'initial' });
    // The batch opened hours ago, but an activity just landed on it: the
    // turn is still alive. Freshness reads the latest attached activity,
    // not just created_at — created_at alone would misclassify this.
    handleToolUse(sessionId, 'claude-code', 'Bash', { command: 'bun test' }, undefined, process.cwd());
    backdateBatch(batchId, 7200);
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'hello', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'bun test' }, timestamp: '2026-06-10T10:00:01.000Z' },
      { type: 'stop', last_assistant_message: 'should not land', timestamp: '2026-06-10T10:00:05.000Z' },
    ]);
    makeReconciler().reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches[0].response_summary).toBeNull();
  });

  it('replayed stop recovers onto a STALE open batch without closing it', () => {
    const sessionId = 'conv-stop-stale-open';
    seedSession({ id: sessionId });
    const { batchId } = handleUserPrompt(sessionId, 'hello', { kind: 'initial' });
    backdateBatch(batchId, 7200);
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'hello', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'stop', last_assistant_message: 'missed-stop recovery', timestamp: '2026-06-10T10:00:05.000Z' },
    ]);
    makeReconciler().reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].response_summary).toBe('missed-stop recovery');
    expect(batches[0].ended_at).toBeNull();
  });

  it('replayed stop fills a closed batch with NULL summary', () => {
    const sessionId = 'conv-stop-closed';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'hello', { kind: 'initial' });
    handleStopBatches(sessionId);
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'hello', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'stop', last_assistant_message: 'recovered summary', timestamp: '2026-06-10T10:00:05.000Z' },
    ]);
    makeReconciler().reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].response_summary).toBe('recovered summary');
  });

  // Full-turn-missed: the daemon was down for the WHOLE turn — prompt, tool
  // events, and stop all live only in the buffer. The chronological walk
  // replays the prompt first, and the stop (replayed in position, exempt
  // from the freshness guard because the batch was created by this pass)
  // lands its summary on the pass-created batch.
  it('recovers a fully-missed turn: prompt, activity, and stop summary all land', () => {
    const sessionId = 'conv-full-turn-missed';
    seedSession({ id: sessionId });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'fix the flaky test', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'bun test' }, timestamp: '2026-06-10T10:00:30.000Z' },
      { type: 'stop', last_assistant_message: 'done, fixed', timestamp: '2026-06-10T10:01:00.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('fix the flaky test');
    expect(batches[0].response_summary).toBe('done, fixed');
    expect(countActivities(sessionId)).toBe(1);
  });

  // Two fully-missed turns: each stop, replayed at its chronological
  // position, lands on its OWN turn's batch — the second turn's summary
  // must not leak onto the first (and vice versa).
  it('recovers two fully-missed turns with each stop on its own batch', () => {
    const sessionId = 'conv-two-turns-missed';
    seedSession({ id: sessionId });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'first turn prompt', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'stop', last_assistant_message: 'first turn answer', timestamp: '2026-06-10T10:01:00.000Z' },
      { type: 'user_prompt', prompt: 'second turn prompt', origin: 'human', timestamp: '2026-06-10T10:05:00.000Z' },
      { type: 'stop', last_assistant_message: 'second turn answer', timestamp: '2026-06-10T10:06:00.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(2);
    const byPrompt = new Map(batches.map((b) => [b.user_prompt, b.response_summary]));
    expect(byPrompt.get('first turn prompt')).toBe('first turn answer');
    expect(byPrompt.get('second turn prompt')).toBe('second turn answer');
  });

  // Shape 15: the activity-key edge set.
  it('a stored NULL tool_input converges with falsy event-side inputs (0 / false / "")', () => {
    const sessionId = 'conv-falsy';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'start', { kind: 'initial' });
    handleToolUse(sessionId, 'claude-code', 'ReadA', undefined, undefined, process.cwd());
    handleToolUse(sessionId, 'claude-code', 'ReadB', undefined, undefined, process.cwd());
    handleToolUse(sessionId, 'claude-code', 'ReadC', undefined, undefined, process.cwd());
    expect(countActivities(sessionId)).toBe(3);

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'start', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'ReadA', tool_input: 0, timestamp: '2026-06-10T10:00:01.000Z' },
      { type: 'tool_use', tool_name: 'ReadB', tool_input: false, timestamp: '2026-06-10T10:00:02.000Z' },
      { type: 'tool_use', tool_name: 'ReadC', tool_input: '', timestamp: '2026-06-10T10:00:03.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
    expect(countActivities(sessionId)).toBe(3);
  });

  it('a scalar string tool_input converges across the quoted-vs-unquoted storage gap', () => {
    const sessionId = 'conv-scalar';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'start', { kind: 'initial' });
    handleToolUse(sessionId, 'codex', 'shell', 'pwd', undefined, process.cwd());

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'start', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'shell', tool_input: 'pwd', timestamp: '2026-06-10T10:00:01.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(countActivities(sessionId)).toBe(1);
  });

  it('a >4000-char tool_input torn by storage truncation still converges', () => {
    const sessionId = 'conv-torn-input';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'start', { kind: 'initial' });
    const bigInput = { script: 'z'.repeat(TOOL_INPUT_STORE_LIMIT + 500) };
    handleToolUse(sessionId, 'claude-code', 'Bash', bigInput, undefined, process.cwd());

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'start', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Bash', tool_input: bigInput, timestamp: '2026-06-10T10:00:01.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(countActivities(sessionId)).toBe(1);
  });

  it('bookkeeping rows do not consume tool_use matches', () => {
    const sessionId = 'conv-bookkeeping';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'start', { kind: 'initial' });
    handleSubagentStop(sessionId, 'a1', 'researcher', 'done');
    expect(countActivities(sessionId)).toBe(1);

    // A tool event whose name/input happens to collide with the bookkeeping
    // row's stored shape must still replay — the bookkeeping row is excluded
    // from the convergence multiset.
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'start', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'subagent_stop', tool_input: { agent_id: 'a1', agent_type: 'researcher' }, timestamp: '2026-06-10T10:00:01.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(countActivities(sessionId)).toBe(2);
  });

  it('a tool_failure row does not consume a tool_use event (and vice versa)', () => {
    const sessionId = 'conv-failure-disc';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'start', { kind: 'initial' });
    handleToolFailure(sessionId, 'claude-code', 'Bash', { command: 'x' }, 'boom', false);
    expect(countActivities(sessionId)).toBe(1);

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'start', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'x' }, timestamp: '2026-06-10T10:00:01.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities).toHaveLength(2);
    expect(activities.filter((a) => a.success === 0)).toHaveLength(1);
    expect(activities.filter((a) => a.success === 1)).toHaveLength(1);
  });

  // Activity backfill — the count-based pass could NEVER do this: when
  // prompt counts matched, no replay ran at all, so a missed activity on a
  // captured turn was lost forever.
  it('replays a missed activity even when no prompt diverged (activity backfill)', () => {
    const sessionId = 'conv-backfill';
    seedSession({ id: sessionId });
    const { batchId } = handleUserPrompt(sessionId, 'investigate the flake', { kind: 'initial' });
    expect(countActivities(sessionId)).toBe(0);

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'investigate the flake', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'bun test' }, timestamp: '2026-06-10T10:00:01.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities).toHaveLength(1);
    expect(activities[0].prompt_batch_id).toBe(batchId);
    expect(activities[0].tool_name).toBe('Bash');
  });

  it('two genuine same-text turns >10s apart, both live-processed → nothing replays', () => {
    const sessionId = 'conv-same-text-live';
    seedSession({ id: sessionId });
    handleUserPrompt(sessionId, 'continue', { kind: 'initial' });
    handleUserPrompt(sessionId, 'continue', { kind: 'initial' });
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'continue', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'user_prompt', prompt: 'continue', origin: 'human', timestamp: '2026-06-10T10:00:15.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);
  });

  it('two genuine same-text turns >10s apart, both missed → both replay', () => {
    const sessionId = 'conv-same-text-missed';
    seedSession({ id: sessionId });

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'continue', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
      { type: 'user_prompt', prompt: 'continue', origin: 'human', timestamp: '2026-06-10T10:00:15.000Z' },
    ]);

    makeReconciler().reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);
  });

  // Shared dedup cache: a replayed event's key lands in the SAME cache the
  // live dispatcher consults, so a late live POST of the replayed event is
  // rejected as a duplicate instead of double-inserting.
  it('records replayed events into the shared cache — a late live POST is a duplicate', () => {
    const sessionId = 'conv-shared-cache';
    seedSession({ id: sessionId });
    const cache = new EventDedupCache();

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'replayed prompt', origin: 'human', timestamp: '2026-06-10T10:00:00.000Z' },
    ]);

    makeReconciler(silentLogger, cache).reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);

    // The dispatcher's duplicate check is cache.isDuplicate — a late live
    // POST of the same physical event arrives within the window.
    expect(cache.isDuplicate(
      { type: 'user_prompt', session_id: sessionId, prompt: 'replayed prompt', origin: 'human' },
      Date.now(),
    )).toBe(true);
    expect(cache.isDuplicate(
      { type: 'user_prompt', session_id: sessionId, prompt: 'a different prompt', origin: 'human' },
      Date.now(),
    )).toBe(false);
  });
});
