import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolUse } from '@myco/runner/tool-use.js';
import { harnessById } from '@myco/runner/harnesses.js';
import { runWorker } from '@myco/runner/loop.js';
import { runErrorCode } from '@myco-server-worker/core/reader-codes.js';
import { runErrorWords } from '../../packages/myco-server/ui/src/features/work/words.js';
import { stubProfileHarness, STUB_PROFILE } from '../helpers/stub-profile-harness.js';
import { profileWorkerServer } from '../helpers/profile-worker-server.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const call = (id: string, name: string, input: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const denied = (id: string, name: string) => JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_use_id: id, tool_name: name });

async function drive(lines: readonly string[]) {
  const scratch = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-titling-tools-')));
  const previous = process.env.PATH;
  const ends: Array<{ status: string; error: string | null }> = [];
  const logs: string[] = [];
  stubProfileHarness({ lines });
  try {
    const fetchImpl = profileWorkerServer((async (input, init) => {
      const url = String(input);
      if (url.endsWith('/worker/claim')) return Response.json({ persisted: true, claimed: true, heartbeatMs: 60_000, run: {
        projectId: 'proj_1', id: 'run_haiku', task: 'title-summary', instruction: 'title one session', harness: 'claude-code', runToken: 'tok_run', credentialEnv: {}, profile: { ...STUB_PROFILE, tier: 'low', model: 'haiku', effort: 'low' }, timeoutSeconds: 300,
      } });
      if (url.endsWith('/worker/end')) ends.push(JSON.parse(String(init?.body)));
      return Response.json({ persisted: true, ended: true });
    }) as typeof fetch);
    await runWorker({ serverUrl: 'https://deployment.example', token: 'tok', lockDir: null, only: ['claude-code'], runRoot: scratch, once: true, pollIdleMs: 1_000, log: (line) => logs.push(line), fetchImpl, signal: new AbortController().signal });
    return { ends, logs };
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
}

describe('a low-tier run that bypasses Myco tools', () => {
  it('stops at the first refused shell route and records a specific reader code', async () => {
    const { ends, logs } = await drive([
      call('search', 'ToolSearch', { query: 'myco_run_sessions' }),
      call('cli', 'Bash', { command: 'myco --tool myco_run_sessions --arg material' }), denied('cli', 'Bash'),
      call('python', 'Bash', { command: 'python3 -c "print(1)"' }), denied('python', 'Bash'),
      call('ls', 'Bash', { command: 'ls -l ~/.claude/projects/' }), denied('ls', 'Bash'),
      call('heredoc', 'Bash', { command: 'cat > title << EOF\nx\nEOF' }), denied('heredoc', 'Bash'),
    ]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ status: 'failed', error: 'the harness stopped: error (tools_unused)' });
    expect(runErrorCode(ends[0]!.error)).toBe('agent_tools_unused');
    expect(runErrorWords(runErrorCode(ends[0]!.error))).toBe('The agent didn’t use Myco’s tools.');
    expect(logs.filter((line) => line.includes('called Bash'))).toHaveLength(2);
  });

  it('reports an empty successful turn with the specific code', async () => {
    const { ends } = await drive([]);
    expect(ends[0]).toMatchObject({ status: 'failed', error: 'the harness stopped: error (tools_unused)' });
  });

  it('stops on a failed shell result even when no permission-denied system line is emitted', async () => {
    const { ends, logs } = await drive([
      call('cli', 'Bash'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cli', is_error: true, content: 'Refused' }] } }),
      call('python', 'Bash'), denied('python', 'Bash'),
    ]);
    expect(ends[0]).toMatchObject({ status: 'failed', error: 'the harness stopped: error (tools_unused)' });
    expect(logs.filter((line) => line.includes('called Bash'))).toHaveLength(2);
  });

  it('preserves a turn that calls Myco before an unrelated refused route', async () => {
    const { ends } = await drive([call('material', 'mcp__myco__myco_run_sessions', { op: 'material' }), call('ls', 'Bash'), denied('ls', 'Bash')]);
    expect(ends[0]?.status).toBe('completed');
    expect(ends[0]?.error).toContain('Bash (refused)');
  });
});


describe('the common run tool-use gate', () => {
  it('leaves source reads and genuine harness failures to their existing checks', () => {
    const source = runToolUse(harnessById('claude-code')!.steps, true);
    expect(source({ kind: 'tool_call', name: 'Bash', status: 'error', refused: true })).toBeNull();
    const task = runToolUse(harnessById('claude-code')!.steps, false);
    expect(task({ kind: 'ended', stop: 'error', code: 'login_missing', detail: null })).toBeNull();
    expect(task({ kind: 'tool_call', name: 'ToolSearch', status: 'error' })).toBeNull();
    expect(task({ kind: 'tool_call', name: 'mcp__myco__myco_run_sessions', status: 'error', refused: true })).toBeNull();
  });

  it('recognizes Myco calls by each driver’s declared vocabulary', () => {
    for (const [harness, name, category] of [['claude-code', 'mcp__myco__myco_run_sessions', undefined], ['codex', 'myco_run_sessions', 'mcp'], ['opencode', 'mcp__myco__myco_run_sessions', 'other']] as const) {
      const observe = runToolUse(harnessById(harness)!.steps, false);
      expect(observe({ kind: 'tool_call', name, category, status: 'started' })).toBeNull();
      expect(observe({ kind: 'tool_call', name: 'Bash', status: 'error', refused: true })).toBeNull();
    }
  });

  it('preserves a lookup failure ending and rejects a successful ending without Myco use', () => {
    for (const stop of ['error', 'end_turn'] as const) {
      const observe = runToolUse(harnessById('claude-code')!.steps, false);
      expect(observe({ kind: 'tool_call', name: 'ToolSearch', status: 'error' })).toBeNull();
      const ending = observe({ kind: 'ended', stop, code: 'harness_error', detail: null });
      expect(ending).toEqual(stop === 'error' ? null : { kind: 'ended', stop: 'error', code: 'tools_unused', detail: null });
    }
  });
});
