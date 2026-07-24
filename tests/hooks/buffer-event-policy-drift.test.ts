import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CAPTURE_EVENT_POLICY } from '@myco/capture/event-policy.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveProjectBufferDir, resolveServiceDaemonStatePath } from '@myco/grove/paths.js';
import { getPluginVersion } from '@myco/version.js';
import { listenEphemeral, closeServer } from '../helpers/net.js';
import { testPerUserLocksRoot } from '../helpers/per-user-lock-namespace.js';

const TEST_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Behavioral guard for each hook's bufferEvent construction: every capture
 * hook offers a buffer-fallback copy, except that a `stop` with no summary
 * passes `bufferEvent: null` (an empty stop never writes a no-op row). The
 * behavior lives in each hook's source — nothing else would fail if a hook
 * silently stopped offering a copy. This test closes that gap: it runs
 * every hook the policy table covers against a daemon stub whose `/events`
 * POSTs fail (a non-2xx — the unconditional-buffer row of the fallback
 * decision table), then asserts the buffer file's presence:
 *
 *   - content-present payload → the event is buffered;
 *   - `payloadWithoutContent` (stop with no summary) → never buffered.
 *
 * A policy row with no hook mapping here fails loudly, so the table cannot
 * grow without this guard growing with it.
 */
describe('policy table ↔ hook bufferEvent behavior (drift guard)', () => {
  let mycoHome: string;
  let projectRoot: string;
  let transcriptPath: string;
  let bufferDir: string;
  let server: http.Server;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-buffer-policy-drift-'));
    const vaultDir = path.join(projectRoot, '.myco');
    mycoHome = path.join(projectRoot, 'home');
    transcriptPath = path.join(projectRoot, 'transcript.jsonl');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(mycoHome, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      `[project]\nid = "${TEST_PROJECT_ID}"\nname = "buffer-policy-drift"\n`,
      'utf-8',
    );
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
    fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
    const grove = createGrove('test', mycoHome);
    registerProjectInGrove(grove.id, {
      projectId: TEST_PROJECT_ID,
      projectName: 'buffer-policy-drift',
      projectRoot,
    }, mycoHome);
    bufferDir = resolveProjectBufferDir(grove.id, TEST_PROJECT_ID, mycoHome);

    // Daemon stub: healthy (so user-prompt-submit's ensureRunning returns
    // fast) but every other request — /events, /events/stop, /context/* —
    // answers 500. A non-2xx makes capturePost return `{ok:false}`
    // immediately with no recovery loop, putting every hook on the
    // unconditional-buffer row, where buffering happens iff the hook
    // offered a bufferEvent at all.
    const listening = await listenEphemeral((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true, pid: process.pid, version: getPluginVersion() }));
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub failure' }));
    });
    server = listening.server;
    const statePath = resolveServiceDaemonStatePath(mycoHome);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: listening.port }));
  });

  afterAll(async () => {
    await closeServer(server);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // Async spawn, NOT spawnSync: the daemon stub lives in this test process,
  // and spawnSync would block the event loop the stub needs to answer the
  // child's requests — a guaranteed deadlock-until-timeout.
  function runHook(hook: string, payload: Record<string, unknown>): Promise<{ status: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.resolve('tests/helpers/capture-hook-helper.ts'),
          testPerUserLocksRoot,
          hook,
          '--symbiont',
          'claude-code',
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, MYCO_NO_AUTO_SPAWN: '1', MYCO_HOME: mycoHome },
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
      child.on('error', reject);
      child.on('close', (status) => resolve({ status }));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  function bufferedTypes(sessionId: string): string[] {
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(bufferPath)) return [];
    const raw = fs.readFileSync(bufferPath, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => String(JSON.parse(line).type));
  }

  /**
   * One hook invocation per policy row. `payload` carries the row's
   * "content present" shape; `payloadWithoutContent` (stop) carries the
   * same event with nothing to recover, which must not buffer.
   */
  const HOOK_FOR_TYPE: Record<string, {
    hook: string;
    payload: Record<string, unknown>;
    payloadWithoutContent?: Record<string, unknown>;
  }> = {
    user_prompt: {
      hook: 'user-prompt-submit',
      payload: { prompt: 'a real user prompt for the drift guard' },
    },
    tool_use: {
      hook: 'post-tool-use',
      payload: { tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_output: 'ok' },
    },
    tool_failure: {
      hook: 'post-tool-use-failure',
      payload: { tool_name: 'Bash', tool_input: { command: 'pwd' }, error: 'exit 1' },
    },
    stop: {
      hook: 'stop',
      payload: { last_assistant_message: 'The final answer for this turn.' },
      payloadWithoutContent: {},
    },
    subagent_start: {
      hook: 'subagent-start',
      payload: { agent_id: 'sub-001', agent_type: 'Explore' },
    },
    subagent_stop: {
      hook: 'subagent-stop',
      payload: { agent_id: 'sub-001', agent_type: 'Explore', last_assistant_message: 'done' },
    },
    stop_failure: {
      hook: 'stop-failure',
      payload: { error: 'stop pipeline failed' },
    },
    task_completed: {
      hook: 'task-completed',
      payload: { task_id: 'task-1', task_subject: 'subject' },
    },
    pre_compact: {
      hook: 'pre-compact',
      payload: { trigger: 'auto' },
    },
    post_compact: {
      hook: 'post-compact',
      payload: { trigger: 'auto', compact_summary: 'compacted' },
    },
    notification: {
      hook: 'notification',
      payload: { message: 'agent paused' },
    },
    error_occurred: {
      hook: 'error-occurred',
      payload: { message: 'network fault', code: 'ECONN' },
    },
  };

  it('covers every policy row with a hook mapping', () => {
    expect(Object.keys(HOOK_FOR_TYPE).sort()).toEqual(Object.keys(CAPTURE_EVENT_POLICY).sort());
  });

  for (const type of Object.keys(CAPTURE_EVENT_POLICY)) {
    it(`${type}: hook buffers on daemon failure${HOOK_FOR_TYPE[type]?.payloadWithoutContent ? ' (and never without content)' : ''}`, async () => {
      const mapping = HOOK_FOR_TYPE[type];
      expect(mapping).toBeDefined();

      const sessionId = `buffer-policy-${type.replace(/_/g, '-')}-001`;
      const result = await runHook(mapping.hook, {
        ...mapping.payload,
        session_id: sessionId,
        transcript_path: transcriptPath,
      });
      expect(result.status).toBe(0);

      // Content-present payloads buffer on the unconditional-buffer row.
      expect(bufferedTypes(sessionId)).toEqual([type]);

      if (mapping.payloadWithoutContent) {
        const emptySessionId = `buffer-policy-${type.replace(/_/g, '-')}-empty-001`;
        const emptyResult = await runHook(mapping.hook, {
          ...mapping.payloadWithoutContent,
          session_id: emptySessionId,
          transcript_path: transcriptPath,
        });
        expect(emptyResult.status).toBe(0);
        expect(bufferedTypes(emptySessionId)).toEqual([]);
      }
    }, 20_000);
  }
});
