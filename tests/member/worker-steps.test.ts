import { CORPUS } from '../helpers/secret-corpus.ts';
/**
 * A worker's step log: what each harness's calls read as, what the log never holds, and how it reaches the Deployment.
 *
 * The drivers run against their harnesses' streams and the log is built from their events by the harness's own
 * manifest rules, so these feed the real drivers and the real rules rather than restating either. The log's delivery
 * runs the shipped worker against the real server pipeline, as `worker-claim-wire.test.ts` does.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeDriver } from '@myco/runner/drivers/claude-code.js';
import { codexDriver } from '@myco/runner/drivers/codex.js';
import { AcpEvents } from '@myco/runner/drivers/acp-events.js';
import { writeRunDir } from '@myco/runner/mcp-config.js';
import { HARNESSES, harnessById } from '@myco/runner/harnesses.js';
import { StepLog, stepOf } from '@myco/runner/steps.js';
import { deliverStepOutbox, outboxDir, STEP_OUTBOX_RETENTION_MS, sweepStepOutbox, writeStepOutbox, type StepOutboxEntry } from '@myco/runner/step-outbox.js';
import { runWorker } from '@myco/runner/loop.js';
import { deploymentScopedHeaders } from '@myco/member/constants.js';
import type { RunEvent } from '@myco/runner/events.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { expireLeases } from '@myco-server-worker/core/harness.js';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { harnessStoppedError } from '@goondocks/myco-shared/run-text';
import { MAX_RUN_STEPS, WORKER_STEPS_FEATURE } from '@goondocks/myco-shared/worker-steps';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { sqliteEnv, turnOnGatedCapabilities } from '../myco-server/helpers/fixtures.ts';
import { PROFILE_STUB_DETECTED, PROFILE_STUB_HARNESS, stubProfileHarness } from '../helpers/stub-profile-harness.ts';
import { withRunMcp } from '../helpers/run-mcp-fetch.ts';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const NOW = 1_800_000_000_000;
const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret' };
const FILE_BODY = 'the whole body of a file the run wrote';
const COMMAND_OUTPUT = 'what the command printed to its terminal';
const ACCESS_KEY = 'abcdef0123456789abcdef';

function stubHarness(name: string, lines: readonly string[]): string {
  const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-stub-')));
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join('\n')}\nexit 0\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return dir;
}

async function logOf(harness: string, events: AsyncIterable<RunEvent>): Promise<ReturnType<StepLog['result']>> {
  let at = NOW;
  const log = new StepLog(harnessById(harness)!, () => (at += 1));
  for await (const event of events) log.observe(event);
  return log.result();
}

const runDir = () => writeRunDir(removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-run-'))), 'run_1', CONNECTION);

/** A Claude Code stream with a read, a write, a search, a command that fails, a refused call, a Myco call and records the driver does not read. */
const CLAUDE_STREAM = [
  '{"type":"system","subtype":"init","session_id":"sess_9"}',
  '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
  '{"type":"system","subtype":"thinking_tokens","tokens":12}',
  '{"type":"mystery_record","payload":{}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"src/runner/loop.ts"}}]}}',
  `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"export function drive() {}"}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"Write","input":{"file_path":"notes.md","content":${JSON.stringify(FILE_BODY)}}}]}}`,
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","content":"File written"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_3","name":"Grep","input":{"pattern":"leaseDeadline","path":"src"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_3","content":"src/runner/loop.ts:270"}]}}',
  `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_4","name":"Bash","input":{"command":"curl -H \\"Authorization: Bearer ${ACCESS_KEY}\\" https://example.test"}}]}}`,
  `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_4","is_error":true,"content":${JSON.stringify(`Exit code 7\n${COMMAND_OUTPUT}`)}}]}}`,
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_5","name":"WebFetch","input":{"url":"https://example.test/doc"}}]}}',
  '{"type":"system","subtype":"permission_denied","tool_name":"WebFetch","tool_use_id":"tu_5"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_7","name":"LS","input":{"path":"src/runner"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_7","content":"loop.ts"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_6","name":"mcp__myco__myco_run","input":{"op":"report","action":"extract"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_6","content":"{\\"recorded\\":true}"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}',
];

describe('each harness\'s step rules', () => {
  it('are declared by every harness a worker runs, and never read a target from what a call wrote or returned', () => {
    const CONTENT = /^(content|contents|output|stdout|stderr|result|results|text|old_string|new_string|diff|patch|body|aggregated_output)$/i;
    for (const harness of HARNESSES) {
      expect({ harness: harness.id, rules: harness.steps.length > 0 }).toEqual({ harness: harness.id, rules: true });
      const read = harness.steps.flatMap((rule) => rule.target.flatMap((field) => field.split('.'))).filter((segment) => CONTENT.test(segment));
      expect({ harness: harness.id, read }).toEqual({ harness: harness.id, read: [] });
    }
  });
});

describe('a step log from a harness\'s stream', () => {
  it('reads a Claude Code run as its steps: each action, its one target and outcome, and no contents, output or access key', async () => {
    process.env.PATH = `${stubHarness('claude', CLAUDE_STREAM)}:${process.env.PATH ?? ''}`;
    const { steps, overflow, unrecognized } = await logOf('claude-code', claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(steps.map(({ seq, callId, kind, tool, target, outcome, exitCode }) => ({ seq, callId, kind, tool, target, outcome, exitCode }))).toEqual([
      { seq: 0, callId: 'tu_1', kind: 'read', tool: 'Read', target: 'src/runner/loop.ts', outcome: 'ok', exitCode: null },
      { seq: 1, callId: 'tu_2', kind: 'edit', tool: 'Write', target: 'notes.md', outcome: 'ok', exitCode: null },
      { seq: 2, callId: 'tu_3', kind: 'search', tool: 'Grep', target: null, outcome: 'ok', exitCode: null },
      { seq: 3, callId: 'tu_4', kind: 'command', tool: 'Bash', target: 'curl -H … https://example.test', outcome: 'error', exitCode: 7 },
      { seq: 4, callId: 'tu_5', kind: 'fetch', tool: 'WebFetch', target: 'https://example.test', outcome: 'refused', exitCode: null },
      // A directory listing reads no file: it is a search of that directory.
      { seq: 5, callId: 'tu_7', kind: 'search', tool: 'LS', target: 'src/runner', outcome: 'ok', exitCode: null },
      { seq: 6, callId: 'tu_6', kind: 'myco', tool: 'mcp__myco__myco_run', target: 'report', outcome: 'ok', exitCode: null },
    ]);
    expect(steps.every((step) => step.endedAt !== null && step.endedAt >= step.startedAt)).toBe(true);
    expect(overflow).toBe(0);
    // Hook, rate-limit and thinking records are named by the manifest as never carrying a call; only the record that
    // might have held one is counted.
    expect(unrecognized).toEqual({ total: 1, shapes: { mystery_record: 1 } });
    const kept = JSON.stringify(steps);
    for (const never of [FILE_BODY, COMMAND_OUTPUT, ACCESS_KEY, 'export function drive', 'src/runner/loop.ts:270']) expect({ never, kept: kept.includes(never) }).toEqual({ never, kept: false });
  });

  it('reads a Codex run\'s items as its steps, a call to Myco\'s own server by its arguments and any other server\'s by nothing, and an item it does not know as unrecognized', async () => {
    process.env.PATH = `${stubHarness('codex', [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}',
      `{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","aggregated_output":${JSON.stringify(COMMAND_OUTPUT)},"exit_code":2,"status":"failed"}}`,
      '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"docs/notes.md","kind":"add"}],"status":"completed"}}',
      '{"type":"item.started","item":{"id":"i3","type":"mcp_tool_call","server":"myco","tool":"myco_run","arguments":{"op":"report"},"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"i3","type":"mcp_tool_call","server":"myco","tool":"myco_run","arguments":{"op":"report"},"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"i6","type":"mcp_tool_call","server":"context7","tool":"resolve","arguments":{"op":"hunter22"},"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"i4","type":"collab_tool_call","status":"completed"}}',
      '{"type":"session.compacted"}',
      '{"type":"item.completed","item":{"id":"i5","type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ])}:${process.env.PATH ?? ''}`;
    const { steps, unrecognized } = await logOf('codex', codexDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(steps.map(({ callId, kind, tool, target, outcome, exitCode }) => ({ callId, kind, tool, target, outcome, exitCode }))).toEqual([
      { callId: 'i1', kind: 'command', tool: 'command_execution', target: 'bash -l… ls', outcome: 'error', exitCode: 2 },
      { callId: 'i2', kind: 'edit', tool: 'file_change', target: 'docs/notes.md', outcome: 'ok', exitCode: null },
      { callId: 'i3', kind: 'myco', tool: 'myco_run', target: 'report', outcome: 'ok', exitCode: null },
      { callId: 'i6', kind: 'tool', tool: 'resolve', target: null, outcome: 'ok', exitCode: null },
    ]);
    expect(unrecognized).toEqual({ total: 2, shapes: { 'item.completed/collab_tool_call': 1, 'session.compacted': 1 } });
    expect(JSON.stringify(steps)).not.toContain(COMMAND_OUTPUT);
  });

  it('reads an agent-protocol run\'s calls by the protocol\'s own kind of each, and an update it does not know as unrecognized', () => {
    const acp = new AcpEvents('opencode', null, {});
    const update = (body: Record<string, unknown>) => [...acp.update({ method: 'session/update', params: { sessionId: 's', update: body } }, 's')];
    let at = NOW;
    const log = new StepLog(harnessById('opencode')!, () => (at += 1));
    for (const event of [
      ...update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read loop.ts', kind: 'read', status: 'pending', locations: [{ path: '/repo/src/runner/loop.ts' }] }),
      ...update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: FILE_BODY } }] }),
      ...update({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } }),
      ...update({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'failed', rawOutput: { output: COMMAND_OUTPUT } }),
      ...update({ sessionUpdate: 'plan', entries: [] }),
      ...update({ sessionUpdate: 'mystery_update' }),
      ...[...acp.refused({ toolCallId: 'c3', title: 'rm -rf build', kind: 'execute', rawInput: { command: 'rm -rf build' } })],
    ]) log.observe(event);
    const { steps, unrecognized } = log.result();
    expect(steps.map(({ callId, kind, tool, target, outcome }) => ({ callId, kind, tool, target, outcome }))).toEqual([
      { callId: 'c1', kind: 'read', tool: 'read', target: '/repo/src/runner/loop.ts', outcome: 'ok' },
      { callId: 'c2', kind: 'command', tool: 'execute', target: 'npm test', outcome: 'error' },
      { callId: 'c3', kind: 'command', tool: 'execute', target: 'rm -rf …', outcome: 'refused' },
    ]);
    expect(unrecognized).toEqual({ total: 1, shapes: { 'session/update:mystery_update': 1 } });
    expect(JSON.stringify(steps)).not.toContain(FILE_BODY);
  });

  it('names an agent-protocol call to one of Myco\'s listed tools as the Myco call it is, by each form its manifest declares, and nothing else', () => {
    for (const harness of ['opencode', 'cursor', 'antigravity']) {
      const acp = new AcpEvents(harness, null, {}, undefined, [], new Set(['myco_run_map', 'myco_run']));
      const update = (body: Record<string, unknown>) => [...acp.update({ method: 'session/update', params: { sessionId: 's', update: body } }, 's')];
      const log = new StepLog(harnessById(harness)!, () => NOW);
      for (const event of [
        ...update({ sessionUpdate: 'tool_call', toolCallId: 'm1', title: 'myco_myco_run_map', kind: 'other', status: 'pending', rawInput: { op: 'write', text: FILE_BODY } }),
        ...update({ sessionUpdate: 'tool_call_update', toolCallId: 'm1', status: 'completed' }),
        ...update({ sessionUpdate: 'tool_call', toolCallId: 'm2', title: 'mcp__myco__myco_run', kind: 'other', status: 'completed', rawInput: { op: 'report' } }),
        ...update({ sessionUpdate: 'tool_call', toolCallId: 'm3', title: 'myco: myco_run_map', kind: 'other', status: 'completed', rawInput: { providerIdentifier: 'myco', toolName: 'myco_run_map', args: { op: 'get' } } }),
        // A title naming a tool Myco did not list, and another server's tool, are not calls to Myco.
        ...update({ sessionUpdate: 'tool_call', toolCallId: 'm4', title: 'myco_myco_unlisted', kind: 'other', status: 'completed' }),
        ...update({ sessionUpdate: 'tool_call', toolCallId: 'm5', title: 'other: myco_run', kind: 'other', status: 'completed', rawInput: { providerIdentifier: 'other', toolName: 'myco_run' } }),
      ]) log.observe(event);
      expect({ harness, steps: log.result().steps.map(({ callId, kind, tool, target }) => ({ callId, kind, tool, target })) }).toEqual({ harness, steps: [
        { callId: 'm1', kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'write' },
        { callId: 'm2', kind: 'myco', tool: 'mcp__myco__myco_run', target: 'report' },
        { callId: 'm3', kind: 'myco', tool: 'mcp__myco__myco_run_map', target: 'get' },
        { callId: 'm4', kind: 'tool', tool: 'other', target: null },
        { callId: 'm5', kind: 'tool', tool: 'other', target: null },
      ] });
      expect(JSON.stringify(log.result().steps)).not.toContain(FILE_BODY);
    }
  });

  it('writes a path inside the run\'s checkout relative to it, as given or resolved, and leaves every other path as shaped before', () => {
    const root = '/private/var/folders/x1/myco-run-Xk29fQ7aLm/repo';
    const given = '/var/folders/x1/myco-run-Xk29fQ7aLm/repo';
    const log = new StepLog(harnessById('claude-code')!, () => NOW);
    log.within(given, root);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['Read', { file_path: `${given}/packages/x/y.ts` }],
      ['Read', { file_path: `${root}/packages/z.ts` }],
      ['Bash', { command: `git -C ${given} ls-tree -r HEAD` }],
      ['Bash', { command: `cd ${root} && npm test` }],
      ['Read', { file_path: '/etc/hosts' }],
      ['Read', { file_path: `${given}-sibling/a.ts` }],
    ];
    calls.forEach(([name, input], i) => {
      log.observe({ kind: 'tool_call', name, status: 'started', callId: `p${i}`, input });
      log.observe({ kind: 'tool_call', name, status: 'ok', callId: `p${i}` });
    });
    expect(log.result().steps.map((step) => step.target)).toEqual([
      'packages/x/y.ts', 'packages/z.ts', 'git -C . ls-tree -r …', 'cd . && npm test', '/etc/hosts', '…',
    ]);
    // Without the checkout, its random directory name is kept only as `…`.
    expect(stepOf(harnessById('claude-code')!.steps, { name: 'Read', input: { file_path: `${given}/packages/x/y.ts` } }).target).toBe('…');
    // The secret corpus still holds: no key a target carries survives being written relative to the checkout.
    for (const secret of [ACCESS_KEY, `postgres://admin:S3cret@db/${ACCESS_KEY}`]) {
      const shaped = stepOf(harnessById('claude-code')!.steps, { name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${secret}" ${given}/a.ts` } }, [given]).target ?? '';
      expect({ secret, kept: shaped.includes(ACCESS_KEY) }).toEqual({ secret, kept: false });
    }
  });

  it('counts none of the records Claude Code was seen to send that never carry a call', () => {
    const log = new StepLog(harnessById('claude-code')!, () => NOW);
    for (const shape of ['rate_limit_event', 'system/commands_changed', 'system/thinking_tokens']) log.observe({ kind: 'unrecognized', shape });
    expect(log.result().unrecognized).toEqual({ total: 0, shapes: {} });
  });

  it('counts only the records a manifest does not name as never carrying a call', () => {
    for (const harness of HARNESSES) {
      const log = new StepLog(harness, () => NOW);
      for (const shape of harness.notSteps) log.observe({ kind: 'unrecognized', shape });
      log.observe({ kind: 'unrecognized', shape: 'mystery_record' });
      expect({ harness: harness.id, unrecognized: log.result().unrecognized }).toEqual({ harness: harness.id, unrecognized: { total: 1, shapes: { mystery_record: 1 } } });
    }
    expect(harnessById('claude-code')!.notSteps).toEqual(expect.arrayContaining(['system/thinking_tokens', 'rate_limit_event']));
  });

  it('keeps at most its bound of steps and counts the rest, and counts every unrecognized record past the shapes it names', () => {
    const log = new StepLog(harnessById('claude-code')!, () => NOW);
    for (let i = 0; i < MAX_RUN_STEPS + 5; i += 1) {
      log.observe({ kind: 'tool_call', name: 'Read', status: 'started', callId: `c${i}`, input: { file_path: `f${i}` } });
      log.observe({ kind: 'tool_call', name: 'Read', status: 'ok', callId: `c${i}` });
    }
    for (let i = 0; i < 40; i += 1) log.observe({ kind: 'unrecognized', shape: `shape-${i}` });
    const { steps, overflow, unrecognized } = log.result();
    expect(steps).toHaveLength(MAX_RUN_STEPS);
    expect(steps.at(-1)).toMatchObject({ seq: MAX_RUN_STEPS - 1, target: `f${MAX_RUN_STEPS - 1}`, outcome: 'ok' });
    expect(overflow).toBe(5);
    expect(unrecognized.total).toBe(40);
    expect(Object.keys(unrecognized.shapes)).toHaveLength(32);
  });

  it('keeps a command\'s first line as its target, never the body the lines after it carry', () => {
    const rules = harnessById('claude-code')!.steps;
    expect(stepOf(rules, { name: 'Bash', input: { command: `\ncat > notes.md <<'EOF'\n${FILE_BODY}\nEOF` } })).toEqual({ kind: 'command', target: 'cat > … << …', byName: true });
    // A command whose later lines are dropped ends in `…`, so its first line never reads as the whole command.
    expect(stepOf(rules, { name: 'Bash', input: { command: 'npm test\nnpm run lint' } })).toEqual({ kind: 'command', target: 'npm test …', byName: true });
    expect(stepOf(rules, { name: 'Read', input: { file_path: 'x'.repeat(400) } }).target).toBe('…');
    expect(stepOf(rules, { name: 'Unmapped', input: { file_path: 'a.ts' } })).toEqual({ kind: 'tool', target: null, byName: false });
  });

  it('reads a call still open when the run ends as unfinished', () => {
    const log = new StepLog(harnessById('claude-code')!, () => NOW);
    log.observe({ kind: 'tool_call', name: 'Bash', status: 'started', callId: 'c1', input: { command: 'sleep 600' } });
    expect(log.result().steps).toEqual([{ seq: 0, callId: 'c1', kind: 'command', tool: 'Bash', target: 'sleep …', outcome: 'unfinished', exitCode: null, startedAt: NOW, endedAt: null }]);
  });
});

/** A run's tool calls in the stub harness's stream, and the four steps they read as. */
const STUB_LINES = [
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"README.md"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"# readme"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"Bash","input":{"command":"git log -1"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","content":"commit abc"}]}}',
  '{"type":"stream_event","event":{}}',
];

async function wire(opts: { advertise?: boolean; lines?: readonly string[]; slowPages?: boolean; failure?: boolean } = {}) {
  expect(stubProfileHarness({ lines: opts.lines ?? STUB_LINES, ...(opts.failure ? { ending: '{"type":"result","subtype":"error_during_execution","is_error":true,"stop_reason":"error","errors":["fixture failure"]}' } : {}) })).toEqual(PROFILE_STUB_DETECTED);
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite, ['proj_1']);
  let clock = Date.now();
  const now = () => opts.slowPages ? clock : Date.now();
  const server = createServer({ now, sourceOf: () => '1.2.3.4', fetchImpl: (input, init) => fetch(input, init) });
  const sent: Array<{ path: string; body: string }> = [];
  let refuseSteps = false;
  let advertising = opts.advertise !== false;
  let onClaim: (() => void) | null = null;
  const closed: unknown[] = [];
  let deliveryTicks = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(typeof input === 'string' || input instanceof URL ? String(input) : input.url, init);
    const path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? await request.clone().text() : '';
    sent.push({ path, body });
    if (path === '/worker/steps' && refuseSteps) return new Response('unavailable', { status: 503 });
    if (path === '/worker/claim' && onClaim !== null) onClaim();
    if (path === '/worker/steps' && opts.slowPages) {
      const timer = setInterval(() => { deliveryTicks += 1; }, 1);
      try { await Bun.sleep(6); clock += 6_000; } finally { clearInterval(timer); }
    }
    const answer = await server.handleRequest(request, e.serverEnv);
    if (path === '/worker/end') closed.push(await answer.clone().json());
    if (advertising) return answer;
    const headers = new Headers(answer.headers);
    headers.set(FEATURES_HEADER, (headers.get(FEATURES_HEADER) ?? '').split(',').filter((feature) => feature !== WORKER_STEPS_FEATURE).join(','));
    return new Response(answer.body, { status: answer.status, headers });
  }) as unknown as typeof fetch;
  await ensureMember(e.db, 'mem_admin', NOW, 'admin', 'mem_admin');
  const token = (await issueMemberToken(e.db, { memberId: 'mem_admin', machineId: 'mem_admin' }, NOW)).token;
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(
    `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
     VALUES ('proj_1', 'run_steps', 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'do it')`,
    [NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
  );
  const home = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-worker-home-')));
  const runRoot = join(home, 'runs');
  const stepRoot = join(home, 'steps');
  const attach = async (once: boolean) => {
    const stopping = new AbortController();
    const bound = setTimeout(() => { stopping.abort(); }, 10_000);
    if (!once) onClaim = () => { stopping.abort(); };
    try {
      return await withRunMcp('https://deployment.example', (request) => server.handleRequest(request, e.serverEnv), () => runWorker({
        serverUrl: 'https://deployment.example', token, lockDir: null, runRoot, stepRoot, only: [PROFILE_STUB_HARNESS], once, pollIdleMs: 50,
        log: () => {}, fetchImpl, clock: now, signal: stopping.signal,
      }));
    } finally {
      clearTimeout(bound);
      onClaim = null;
    }
  };
  const outbox = () => {
    const dir = outboxDir(stepRoot, 'https://deployment.example');
    return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
  };
  const stored = () => e.sqlite.query(`SELECT seq, call_id AS callId, kind, tool, target, outcome FROM agent_run_steps WHERE run_id = 'run_steps' ORDER BY seq`).all();
  return {
    e, sent, attach, outbox, stored, runRoot, stepRoot, server, token, now, closed, deliveryTicks: () => deliveryTicks,
    refuse: (on: boolean) => { refuseSteps = on; }, advertise: (on: boolean) => { advertising = on; },
  };
}

const STEPS = [
  { seq: 0, callId: 'tu_1', kind: 'read', tool: 'Read', target: 'README.md', outcome: 'ok' },
  { seq: 1, callId: 'tu_2', kind: 'command', tool: 'Bash', target: 'git log -1', outcome: 'ok' },
];

describe('a step log on its way to the Deployment', () => {
  for (const failure of [false, true]) {
    it(`closes a ${failure ? 'failed' : 'completed'} harness before slow multi-page evidence and backlog consume its lease`, async () => {
      const lines = Array.from({ length: 2_000 }, (_, seq) => [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${seq}`, name: seq === 0 ? 'mcp__myco__myco_run' : 'Read', input: seq === 0 ? { op: 'report' } : { file_path: 'README.md' } }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `c${seq}`, content: 'fixture' }] } }),
      ]).flat();
      const w = await wire({ lines, slowPages: true, failure });
      const at = w.now();
      // An older log is delivered before the new attempt is claimed.
      const backlog = writeStepOutbox(w.stepRoot, {
        serverUrl: 'https://deployment.example', projectId: 'proj_1', runId: 'run_absent', attemptId: 'mt_absent', createdAt: at - 1,
        steps: [], overflow: 0, unrecognized: { total: 0, shapes: {} },
      });
      expect(existsSync(backlog)).toBe(true);
      expect((await w.attach(true)).driven).toBe(1);
      const terminal = w.sent.findIndex((s) => s.path === '/worker/end');
      const currentPages = w.sent.flatMap((s, index) => s.path === '/worker/steps' && JSON.parse(s.body).runId === 'run_steps' ? [index] : []);
      expect(currentPages).toHaveLength(20);
      expect(currentPages.every((index) => index > terminal)).toBe(true);
      expect(w.now() - at).toBeGreaterThan(90_000);
      expect(w.deliveryTicks()).toBeGreaterThan(20);
      expect(w.closed).toEqual([expect.objectContaining({ ended: true })]);
      expect(JSON.parse(w.sent[terminal]!.body).status).toBe(failure ? 'failed' : 'completed');
      expect(w.sent.filter((s) => s.path === '/worker/end')).toHaveLength(1);
      expect(w.e.sqlite.query("SELECT status FROM agent_runs WHERE id = 'run_steps'").get()).not.toEqual({ status: 'running' });
      expect(w.stored()).toHaveLength(2_000);
      expect(await expireLeases(w.e.serverEnv, w.now())).toBe(0);
      expect(w.outbox()).toEqual([]);
      const page = w.sent.find((s) => s.path === '/worker/steps' && JSON.parse(s.body).runId === 'run_steps')!;
      const repeated = await w.server.handleRequest(new Request('https://deployment.example/worker/steps', {
        method: 'POST', headers: { ...deploymentScopedHeaders({ token: w.token }), 'content-type': 'application/json' }, body: page.body,
      }), w.e.serverEnv);
      expect(await repeated.json()).toMatchObject({ stored: true, landed: 0 });
    }, 20_000);
  }

  it('lands after the run closes under the attempt that observed it', async () => {
    const w = await wire();
    expect((await w.attach(true)).driven).toBe(1);
    expect(w.sent.map((s) => s.path)).toEqual(['/members/status', '/worker/claim', '/worker/end', '/worker/steps']);
    expect(w.stored()).toEqual(STEPS);
    expect(w.outbox()).toEqual([]);
    const detail = await getRunDetail(w.e.db, { projectId: 'proj_1' }, 'run_steps', Date.now(), 'mem_admin');
    expect(detail?.attempts[0]?.steps).toEqual({ total: 2, received: 2, overflow: 0, unrecognized: { total: 1, shapes: { stream_event: 1 } } });
  });

  it('outlives the run\'s scratch directory and a worker that stopped before sending it, and is sent again byte for byte, once', async () => {
    const w = await wire();
    w.refuse(true);
    expect((await w.attach(true)).driven).toBe(1);
    // The run ended and its scratch directory is gone; the log waits on disk, and nothing of it reached the Deployment.
    expect(readdirSync(w.runRoot).filter((name) => name.startsWith('run_steps-'))).toEqual([]);
    expect(w.stored()).toEqual([]);
    const [file] = w.outbox();
    const entry = JSON.parse(readFileSync(file!, 'utf8')) as StepOutboxEntry;
    expect(entry).toMatchObject({ runId: 'run_steps', acked: 0 });
    expect(entry.pages).toHaveLength(1);

    // A worker started again sends the same bytes, before it claims anything.
    w.refuse(false);
    w.sent.length = 0;
    await w.attach(false);
    const delivered = w.sent.filter((s) => s.path === '/worker/steps').map((s) => s.body);
    expect(delivered).toEqual(entry.pages);
    expect(w.sent.findIndex((s) => s.path === '/worker/steps')).toBeLessThan(w.sent.findIndex((s) => s.path === '/worker/claim'));
    expect(w.stored()).toEqual(STEPS);
    expect(w.outbox()).toEqual([]);

    // A page sent again, as one whose acknowledgement never arrived is, stores nothing twice.
    const again = await w.server.handleRequest(new Request('https://deployment.example/worker/steps', {
      method: 'POST', headers: { ...deploymentScopedHeaders({ token: w.token }), 'content-type': 'application/json' }, body: entry.pages[0],
    }), w.e.serverEnv);
    expect(await again.json() as Record<string, unknown>).toEqual({ persisted: true, stored: true, landed: 0 });
    expect(w.stored()).toEqual(STEPS);
  });

  it('waits on disk while its Deployment does not advertise step logs, and is sent once it does again', async () => {
    const w = await wire();
    w.refuse(true);
    expect((await w.attach(true)).driven).toBe(1);
    expect(w.outbox()).toHaveLength(1);
    w.refuse(false);
    w.advertise(false);
    w.sent.length = 0;
    await w.attach(false);
    expect(w.sent.filter((s) => s.path === '/worker/steps')).toEqual([]);
    expect(w.outbox()).toHaveLength(1);
    w.advertise(true);
    await w.attach(false);
    expect(w.stored()).toEqual(STEPS);
    expect(w.outbox()).toEqual([]);
  });

  it('resumes a log of several pages from the first page the Deployment did not acknowledge', async () => {
    const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-outbox-')));
    const steps = Array.from({ length: 250 }, (_, seq) => ({
      seq, callId: `c${seq}`, kind: 'read' as const, tool: 'Read', target: `f${seq}`, outcome: 'ok' as const, exitCode: null, startedAt: NOW + seq, endedAt: NOW + seq,
    }));
    const file = writeStepOutbox(root, { serverUrl: 'https://deployment.example', projectId: 'proj_1', runId: 'run_1', attemptId: 'mt_1', createdAt: NOW, steps, overflow: 0, unrecognized: { total: 0, shapes: {} } });
    const pages = (JSON.parse(readFileSync(file, 'utf8')) as StepOutboxEntry).pages;
    expect(pages).toHaveLength(3);
    const sent: string[] = [];
    // The first page is acknowledged; the second never is.
    expect(await deliverStepOutbox(file, NOW, async (body) => { sent.push(body); return sent.length === 1 ? 'acked' : 'retry'; }, () => {})).toBe('pending');
    expect((JSON.parse(readFileSync(file, 'utf8')) as StepOutboxEntry).acked).toBe(1);
    sent.length = 0;
    expect(await deliverStepOutbox(file, NOW, async (body) => { sent.push(body); return 'acked'; }, () => {})).toBe('delivered');
    expect(sent).toEqual(pages.slice(1));
    expect(existsSync(file)).toBe(false);
  });

  it('drops a log the Deployment refuses with a code, and the next log is still delivered', async () => {
    const w = await wire();
    // A page no Deployment takes: its tool is not an identifier, which the Deployment refuses as a parse.
    const refused = writeStepOutbox(w.stepRoot, {
      serverUrl: 'https://deployment.example', projectId: 'proj_1', runId: 'run_refused', attemptId: 'mt_refused', createdAt: Date.now() - 1_000,
      steps: [{ seq: 0, callId: 'c0', kind: 'read', tool: 'Read loop.ts', target: 'a.ts', outcome: 'ok', exitCode: null, startedAt: 1, endedAt: 2 }],
      overflow: 0, unrecognized: { total: 0, shapes: {} },
    });
    const refusedBody = (JSON.parse(readFileSync(refused, 'utf8')) as StepOutboxEntry).pages[0];
    expect((await w.attach(true)).driven).toBe(1);
    expect(w.sent.filter((s) => s.path === '/worker/steps').map((s) => s.body === refusedBody)).toEqual([true, false]);
    expect(existsSync(refused)).toBe(false);
    expect(w.stored()).toEqual(STEPS);
    expect(w.outbox()).toEqual([]);
  });

  it('never sends a log that waited past its retention, and removes it', async () => {
    const w = await wire();
    const stale = writeStepOutbox(w.stepRoot, {
      serverUrl: 'https://deployment.example', projectId: 'proj_1', runId: 'run_stale', attemptId: 'mt_stale', createdAt: Date.now() - STEP_OUTBOX_RETENTION_MS - 1,
      steps: [], overflow: 0, unrecognized: { total: 0, shapes: {} },
    });
    const staleBody = (JSON.parse(readFileSync(stale, 'utf8')) as StepOutboxEntry).pages[0];
    expect((await w.attach(true)).driven).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(w.sent.some((s) => s.body === staleBody)).toBe(false);
    expect(w.stored()).toEqual(STEPS);
  });

  it('sweeps an aged log of a Deployment that stopped taking step logs, and of one this machine left', async () => {
    const w = await wire({ advertise: false });
    const aged = Date.now() - STEP_OUTBOX_RETENTION_MS - 1;
    const write = (serverUrl: string, runId: string, createdAt: number) => writeStepOutbox(w.stepRoot, {
      serverUrl, projectId: 'proj_1', runId, attemptId: `mt_${runId}`, createdAt, steps: [], overflow: 0, unrecognized: { total: 0, shapes: {} },
    });
    const rolledBack = write('https://deployment.example', 'run_rolled_back', aged);
    const detached = write('https://another-deployment.example', 'run_detached', aged);
    const waiting = write('https://another-deployment.example', 'run_waiting', Date.now());
    expect((await w.attach(true)).driven).toBe(1);
    expect(w.sent.some((s) => s.path === '/worker/steps')).toBe(false);
    expect([existsSync(rolledBack), existsSync(detached), existsSync(waiting)]).toEqual([false, false, true]);
  });

  it('removes the oldest logs first while the outbox holds more than its bound', () => {
    const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-outbox-cap-')));
    const write = (runId: string, createdAt: number) => writeStepOutbox(root, {
      serverUrl: `https://${runId}.example`, projectId: 'proj_1', runId, attemptId: `mt_${runId}`, createdAt,
      steps: Array.from({ length: 50 }, (_, seq) => ({ seq, callId: `c${seq}`, kind: 'read' as const, tool: 'Read', target: `src/file-${seq}.ts`, outcome: 'ok' as const, exitCode: null, startedAt: 1, endedAt: 2 })),
      overflow: 0, unrecognized: { total: 0, shapes: {} },
    });
    const files = [write('oldest', NOW), write('middle', NOW + 1), write('newest', NOW + 2)];
    const bytes = readFileSync(files[0]!).byteLength;
    expect(sweepStepOutbox(root, NOW + 3, () => {}, bytes * 2)).toBe(1);
    expect(files.map((file) => existsSync(file))).toEqual([false, true, true]);
    expect(sweepStepOutbox(root, NOW + 3, () => {}, bytes * 2)).toBe(0);
  });

  it('is never kept or sent to a Deployment that does not advertise step logs, whose run still closes', async () => {
    const w = await wire({ advertise: false });
    expect((await w.attach(true)).driven).toBe(1);
    expect(w.sent.map((s) => s.path)).toEqual(['/members/status', '/worker/claim', '/worker/end']);
    expect(existsSync(w.stepRoot)).toBe(false);
    // A turn with no Myco call fails at the worker.
    expect(w.e.sqlite.query(`SELECT status, error FROM agent_runs WHERE id = 'run_steps'`).get()).toEqual({ status: 'failed', error: harnessStoppedError('error', { code: 'tools_unused' }) });
    const detail = await getRunDetail(w.e.db, { projectId: 'proj_1' }, 'run_steps', Date.now(), 'mem_admin');
    expect(detail?.attempts.map((attempt) => attempt.steps)).toEqual([null]);
    rmSync(w.stepRoot, { recursive: true, force: true });
  });
});


describe('command payloads through the worker and Deployment', () => {
  it('keeps slash-bearing payloads out of the durable outbox and server rows while retaining a declared file path', async () => {
    const cases = CORPUS.filter((leak) => leak.secrets.some((secret) => secret === 'private/customer-note' || secret === 'customer-note.json'));
    const kept = ['ls -l /etc', 'rg --files src/', 'ls -lh src/', 'rg -e public src/'];
    const shapes = ['ls -l /etc', 'rg --files src/', 'ls -lh src/', 'rg -e … src/'];
    const commands = [...cases.map((leak) => leak.command), ...kept];
    const lines = commands.flatMap((command, i) => [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `payload_${i}`, name: 'Bash', input: { command } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `payload_${i}`, content: 'fixture output' }] } }),
    ]);
    const w = await wire({ lines });
    try {
      w.refuse(true);
      expect((await w.attach(true)).driven).toBe(1);
      const [file] = w.outbox();
      expect(file).toBeDefined();
      const artifact = readFileSync(file!, 'utf8');
      for (const leak of cases) for (const secret of leak.secrets) expect(artifact).not.toContain(secret);
      for (const shape of shapes) expect(artifact).toContain(shape);
      w.refuse(false);
      await w.attach(false);
      const rows = JSON.stringify(w.stored());
      for (const leak of cases) for (const secret of leak.secrets) expect(rows).not.toContain(secret);
      for (const shape of shapes) expect(rows).toContain(shape);
      expect(w.outbox()).toEqual([]);
    } finally { w.e.sqlite.close(); }
  }, 20_000);
});
