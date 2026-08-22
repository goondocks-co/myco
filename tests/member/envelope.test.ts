/**
 * Every hook's envelope, driven through the in-process worker: each kind in
 * the member's table lands `persisted:true` with its projected row. The
 * worker is the oracle — a field the builders misname is refused by name
 * (`unknown_field`) and the test fails on that answer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ID_GRAMMAR, ENVELOPE_FIELDS } from '@myco-server-worker/ingest/envelope.js';
import { KINDS } from '@myco-server-worker/ingest/kinds.js';
import { normalizeHookInput } from '@myco/hooks/normalize.js';
import {
  attachmentEvent, compactionEvent, deriveId, errorEvent, homeRelativePath, mintId, notificationEvent, planEvent, planKeyForTag,
  promptEvent, queuedPromptIdFor, responseEvent, sessionEndEvent, sessionStartEvent, stopFailureEvent, subagentIdFor,
  subagentStartEvent, subagentStopEvent, taskCompletedEvent, toolFailureEvent, toolUseEvent, transcriptSegmentEvent, wireOrigin,
  type EnvelopeContext, type OutboundEvent,
} from '@myco/member/envelope.js';
import { MEMBER_INLINE_TEXT_MAX_BYTES } from '@myco/member/constants.js';
import { TOOL_OUTPUT_PREVIEW_CHARS } from '@myco/constants.js';
import { memberRig, tempMycoHome, tempStager, type MemberRig } from './helpers/server.js';

const ORIGINAL_ENV = { MYCO_HOME: process.env.MYCO_HOME, HOME: process.env.HOME };
let mycoHome: string;
let stager: ReturnType<typeof tempStager>;

beforeAll(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  stager = tempStager();
});
afterAll(() => {
  process.env.MYCO_HOME = ORIGINAL_ENV.MYCO_HOME;
  process.env.HOME = ORIGINAL_ENV.HOME;
});

const SESSION = 'sess-envelope-1';
const ctx = (sessionId = SESSION): EnvelopeContext => ({ agent: 'claude-code', sessionId, stage: stager.stage, version: '2.0.0-test' });
const input = (raw: Record<string, unknown>) => normalizeHookInput({ session_id: SESSION, transcript_path: '/tmp/t.jsonl', ...raw });

/** Post an outbound event as the rig's member, uploading its blob first when it has one. */
async function deliver(rig: MemberRig, out: OutboundEvent): Promise<Record<string, unknown>> {
  if (out.blobSource) expect((await rig.uploadBlob(out.blobSource)).stored).toBe(true);
  return rig.postEvent(out.envelope);
}

const PROJECTION_TABLE: Record<string, string> = {
  'session.start': 'sessions', 'session.end': 'sessions', prompt: 'prompt_batches', 'tool.use': 'tool_calls', 'tool.failure': 'tool_calls',
  response: 'responses', plan: 'plans', attachment: 'attachments', 'transcript.segment': 'transcript_segments',
};

describe('member envelope — every kind through the worker', () => {
  const promptId = mintId();

  const cases: Array<{ kind: string; build: () => OutboundEvent }> = [
    { kind: 'session.start', build: () => sessionStartEvent(ctx(), { branch: 'main', startedAt: Date.now(), originPath: '/work/repo', parentSessionId: 'sess-parent', parentReason: 'resume' }) },
    { kind: 'prompt', build: () => promptEvent(ctx(), { promptId, text: 'hello', origin: 'human' }) },
    { kind: 'tool.use', build: () => toolUseEvent(ctx(), input({ tool_name: 'Read', tool_input: { file_path: '/work/repo/a.ts' }, tool_output: 'x'.repeat(500) }), { promptId }) },
    { kind: 'tool.failure', build: () => toolFailureEvent(ctx(), input({ tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1', is_interrupt: false }), { promptId }) },
    { kind: 'response', build: () => responseEvent(ctx(), { text: 'done', promptId }) },
    { kind: 'subagent.start', build: () => subagentStartEvent(ctx(), input({ agent_id: 'agent-7', agent_type: 'Explore' }), { parentPromptId: promptId }) },
    { kind: 'subagent.stop', build: () => subagentStopEvent(ctx(), input({ agent_id: 'agent-7', agent_type: 'Explore', last_assistant_message: 'ok' }), { parentPromptId: promptId }) },
    { kind: 'compaction.pre', build: () => compactionEvent(ctx(), 'pre', input({ trigger: 'auto' })) },
    { kind: 'compaction.post', build: () => compactionEvent(ctx(), 'post', input({ trigger: 'manual', compact_summary: 'summary text' })) },
    { kind: 'stop.failure', build: () => stopFailureEvent(ctx(), input({ error: 'rate_limit', error_details: { retry: true } })) },
    { kind: 'task.completed', build: () => taskCompletedEvent(ctx(), input({ task_id: 't1', task_subject: 'Ship it', task_description: 'all of it' })) },
    { kind: 'notification', build: () => notificationEvent(ctx(), input({ message: 'needs attention', level: 'warn' })) },
    { kind: 'error', build: () => errorEvent(ctx(), input({ message: 'boom', code: 'E_NET' })) },
    { kind: 'plan', build: () => planEvent(ctx(), { planKey: planKeyForTag(SESSION, 'ultraplan', 0), content: '# Plan\n\ndo it', title: 'Plan', status: 'active', originPath: '/work/repo/.claude/plans/p.md', tags: ['ultraplan'] }) },
    { kind: 'attachment', build: () => attachmentEvent(ctx(), { blobSource: stager.stage(new Uint8Array([137, 80, 78, 71]), 'image/png'), promptId, description: 'screenshot' }) },
    { kind: 'transcript.segment', build: () => transcriptSegmentEvent(ctx(), { transcriptId: `tx_${'a'.repeat(32)}`, baseOffset: 0, blobSource: stager.stage(new TextEncoder().encode('{"type":"user"}\n'), 'text/plain; charset=utf-8'), originPath: '/tmp/t.jsonl' }) },
    { kind: 'session.end', build: () => sessionEndEvent(ctx(), { endedAt: Date.now() }) },
  ];

  it('covers every kind of the server catalogue exactly once', () => {
    expect(cases.map((c) => c.kind).sort()).toEqual(KINDS.map((k) => k.name).sort());
  });

  it('lands every kind persisted:true with its projected row, in hook order', async () => {
    const rig = await memberRig();
    const before: Record<string, number> = {};
    for (const table of new Set(Object.values(PROJECTION_TABLE))) before[table] = rig.rows(table);
    let events = 0;
    for (const c of cases) {
      const out = c.build();
      expect(out.envelope.kind).toBe(c.kind);
      const answer = await deliver(rig, out);
      expect({ kind: c.kind, ...answer }).toMatchObject({ kind: c.kind, persisted: true });
      events += 1;
      expect(rig.rows('events')).toBe(events);
    }
    expect(rig.rows('sessions')).toBe(before.sessions + 1);
    expect(rig.rows('prompt_batches')).toBe(before.prompt_batches + 1);
    expect(rig.rows('tool_calls')).toBe(before.tool_calls + 2);
    expect(rig.rows('responses')).toBe(before.responses + 1);
    expect(rig.rows('plans')).toBe(before.plans + 1);
    expect(rig.rows('attachments')).toBe(before.attachments + 1);
    expect(rig.rows('transcript_segments')).toBe(before.transcript_segments + 1);
    const session = rig.env.sqlite.query(`SELECT branch, origin_path, ended_at FROM sessions WHERE session_id = ?`).get(SESSION) as { branch: string; origin_path: string; ended_at: number };
    expect(session.branch).toBe('main');
    expect(session.origin_path).toBe('/work/repo');
    expect(session.ended_at).toBeGreaterThan(0);
  });

  it('carries only the closed envelope fields and never a member-private key', () => {
    for (const c of cases) {
      const env = c.build().envelope as unknown as Record<string, unknown>;
      expect(Object.keys(env).sort()).toEqual([...ENVELOPE_FIELDS].sort());
      for (const key of Object.keys(env.payload as Record<string, unknown>)) expect(key.startsWith('_')).toBe(false);
      expect(env.channel).toBe('cli');
      expect(env.producer).toEqual({ adapter: 'claude-code', version: '2.0.0-test' });
      expect(ID_GRAMMAR.test(env.eventId as string)).toBe(true);
      expect(Object.values(env.payload as Record<string, unknown>)).not.toContain(undefined);
    }
  });
});

describe('member envelope — field rules', () => {
  it('previews tool output at TOOL_OUTPUT_PREVIEW_CHARS and names myco tools by op', () => {
    const out = toolUseEvent(ctx(), input({ tool_name: 'mcp__myco__myco_cortex', tool_input: { op: 'canopy_map', path: '/x' }, tool_output: 'y'.repeat(1000) }));
    expect(out.envelope.payload).toMatchObject({ toolName: 'mcp__myco__myco_cortex', mycoTool: 'myco_cortex', mycoOp: 'canopy_map', success: true, filesAffected: ['/x'] });
    expect((out.envelope.payload.output as string).length).toBe(TOOL_OUTPUT_PREVIEW_CHARS);
    expect(TOOL_OUTPUT_PREVIEW_CHARS).toBe(200);
  });

  it('spills text over the inline ceiling to a staged blob and keeps it inline otherwise', async () => {
    const small = promptEvent(ctx(), { promptId: mintId(), text: 'short' });
    expect(small.blobSource).toBeUndefined();
    expect(small.envelope.payload.text).toBe('short');
    const big = promptEvent(ctx(), { promptId: mintId(), text: 'z'.repeat(MEMBER_INLINE_TEXT_MAX_BYTES + 1) });
    expect(big.envelope.payload.text).toBeUndefined();
    expect(big.envelope.payload.blob).toBe(big.blobSource!.sha256);
    expect(fs.statSync(big.blobSource!.path).size).toBe(MEMBER_INLINE_TEXT_MAX_BYTES + 1);
    const rig = await memberRig();
    expect(await deliver(rig, big)).toMatchObject({ persisted: true });
    const row = rig.env.sqlite.query(`SELECT blob_key, text FROM prompt_batches WHERE prompt_id = ?`).get(big.envelope.payload.promptId as string) as { blob_key: string; text: string | null };
    expect(row.blob_key).toBe(big.blobSource!.sha256);
    expect(row.text).toBeNull();
  });

  it('measures the inline ceiling on the serialized text: worst-case escaping at the ceiling still lands persisted', async () => {
    // Raw bytes under the ceiling, serialized bytes over it: every char escapes to two.
    const escaped = '"\n'.repeat(Math.floor(MEMBER_INLINE_TEXT_MAX_BYTES / 2) - 100);
    expect(Buffer.byteLength(escaped)).toBeLessThan(MEMBER_INLINE_TEXT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeGreaterThan(MEMBER_INLINE_TEXT_MAX_BYTES);
    const out = promptEvent(ctx(), { promptId: mintId(), text: escaped });
    expect(out.blobSource).toBeDefined();
    const rig = await memberRig();
    expect(await deliver(rig, out)).toMatchObject({ persisted: true });
    // The same escaping under the serialized ceiling stays inline and lands.
    const underCeiling = '"\n'.repeat(Math.floor(MEMBER_INLINE_TEXT_MAX_BYTES / 4) - 100);
    const inline = promptEvent(ctx(), { promptId: mintId(), text: underCeiling });
    expect(inline.blobSource).toBeUndefined();
    expect(await deliver(rig, inline)).toMatchObject({ persisted: true });
  });

  it('refuses to build an empty transcript segment', () => {
    expect(() => transcriptSegmentEvent(ctx(), { transcriptId: `tx_${'a'.repeat(32)}`, baseOffset: 0, blobSource: stager.stage(new Uint8Array(0), 'text/plain') }))
      .toThrow('at least one byte');
  });

  it('puts level only on notification and error', () => {
    expect(notificationEvent(ctx(), input({ message: 'm', level: 'info' })).envelope.payload.level).toBe('info');
    expect(errorEvent(ctx(), input({ message: 'm', code: 'E' })).envelope.payload.level).toBe('E');
    expect('level' in taskCompletedEvent(ctx(), input({ task_subject: 's' })).envelope.payload).toBe(false);
    expect('level' in stopFailureEvent(ctx(), input({ error: 'e' })).envelope.payload).toBe(false);
  });

  it('maps hook-rule origins onto the wire and defaults to user', () => {
    expect(wireOrigin(undefined)).toBe('user');
    expect(wireOrigin('human')).toBe('user');
    expect(wireOrigin('system')).toBe('system');
    expect(wireOrigin('agent_dispatch')).toBe('agent_dispatch');
    expect(wireOrigin('hook_injected')).toBe('hook_injected');
  });

  it('sends originPath home-relative', () => {
    process.env.HOME = path.join(mycoHome, 'userhome');
    try {
      expect(homeRelativePath(path.join(process.env.HOME, 'code', 'repo'))).toBe('~/code/repo');
      expect(homeRelativePath('/opt/elsewhere')).toBe('/opt/elsewhere');
      expect(sessionStartEvent(ctx(), { originPath: path.join(process.env.HOME, 'r') }).envelope.payload.originPath).toBe('~/r');
    } finally {
      process.env.HOME = ORIGINAL_ENV.HOME;
    }
  });

  it('derives deterministic ids in the server id grammar and mints fresh ones', () => {
    expect(subagentIdFor('s', 'a')).toBe(subagentIdFor('s', 'a'));
    expect(subagentIdFor('s', 'a')).not.toBe(subagentIdFor('s', 'b'));
    expect(queuedPromptIdFor('s', 'u')).not.toBe(subagentIdFor('s', 'u'));
    for (const id of [deriveId('x'), subagentIdFor('s', 'a'), planKeyForTag('s', 'ultraplan', 1), queuedPromptIdFor('s', 'u'), mintId()]) {
      expect(ID_GRAMMAR.test(id)).toBe(true);
    }
    expect(mintId()).not.toBe(mintId());
  });

  it('a renamed payload field is refused by name by the worker', async () => {
    const rig = await memberRig();
    const out = promptEvent(ctx(), { promptId: mintId(), text: 'x' });
    const { promptId, ...rest } = out.envelope.payload;
    const answer = await rig.postEvent({ ...out.envelope, payload: { ...rest, prompt_id: promptId } });
    expect(answer).toMatchObject({ persisted: false, code: 'unknown_field' });
  });

  it('an event from a dev build is persisted: the producer version a real binary reports reaches the server intact', async () => {
    const rig = await memberRig();
    // The exact value a dev binary reports — semver build metadata and all.
    // Every hermetic fixture until now passed a clean version string, which is
    // why six review rounds and the whole suite never met this: the grammar
    // was only ever fed values that already satisfied it.
    const devBuild: EnvelopeContext = { agent: 'claude-code', sessionId: SESSION, stage: stager.stage, version: '0.0.0-dev+1.4.8-6-ge1c936ce-dirty' };
    const out = promptEvent(devBuild, { promptId: mintId(), text: 'from a dev build' });

    const answer = await rig.postEvent(out.envelope);

    expect(answer).toMatchObject({ persisted: true });
    expect(rig.rows('prompt_batches')).toBe(1);
    expect((rig.env.sqlite.query('SELECT producer_version FROM events').get() as { producer_version: string }).producer_version)
      .toBe('0.0.0-dev-1.4.8-6-ge1c936ce-dirty');

    // And the version this very build reports, whatever it is, is accepted.
    const real = promptEvent({ ...devBuild, version: undefined }, { promptId: mintId(), text: 'from this build' });
    expect(await rig.postEvent(real.envelope)).toMatchObject({ persisted: true });
  });

  it('queued prompts and subagents derive the same id on a second machine', () => {
    expect(queuedPromptIdFor('sess', 'att-1')).toBe(deriveId('queued-prompt', 'sess', 'att-1'));
    expect(subagentStartEvent(ctx(), input({ agent_id: 'A' })).envelope.payload.subagentId).toBe(subagentIdFor(SESSION, 'A'));
  });
});
