import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths.js';
import { getPluginVersion } from '@myco/version.js';
import { listenEphemeral, closeServer } from '../helpers/net.js';

const TEST_PROJECT_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

/**
 * RC-G guard for the user-prompt-submit drop branch.
 *
 * The drop-path cleanup destroyed six real production sessions when the
 * hook received a PARENT session_id alongside a CHILD transcript (codex
 * subagent spawns). The structural fix is server-side ({expect_empty:
 * true} → 409 session_not_empty unless the session holds zero human
 * batches); this test pins the CLIENT half of the contract against the
 * real hook binary:
 *
 *   - a drop-rule fire issues DELETE /api/sessions/:id with body
 *     {expect_empty: true} — never a bare delete;
 *   - a 409 refusal is logged to stderr and the hook still exits 0
 *     (never crash the agent).
 *
 * Same daemon-stub harness as buffer-event-policy-drift.test.ts — the
 * hook is spawned as a child process, so the stub must be recorded over
 * HTTP rather than by mocking the client.
 */
describe('user-prompt-submit drop branch — phantom-delete contract', () => {
  let mycoHome: string;
  let projectRoot: string;
  let transcriptPath: string;
  let server: http.Server;
  const requests: RecordedRequest[] = [];

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-upsd-drop-'));
    const vaultDir = path.join(projectRoot, '.myco');
    mycoHome = path.join(projectRoot, 'home');
    transcriptPath = path.join(projectRoot, 'transcript.jsonl');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(mycoHome, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      `[project]\nid = "${TEST_PROJECT_ID}"\nname = "upsd-drop"\n`,
      'utf-8',
    );
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
    fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
    const grove = createGrove('test', mycoHome);
    registerProjectInGrove(grove.id, {
      projectId: TEST_PROJECT_ID,
      projectName: 'upsd-drop',
      projectRoot,
    }, mycoHome);

    // Daemon stub: healthy /health; DELETE /api/sessions/* is recorded with
    // its parsed body and answered 200 — except session ids containing
    // "refused", which get the daemon's 409 session_not_empty refusal.
    const listening = await listenEphemeral((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true, pid: process.pid, version: getPluginVersion() }));
        return;
      }
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body: unknown;
        try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        if (req.method === 'DELETE' && req.url?.includes('refused')) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'session_not_empty',
            message: 'expect_empty delete refused: this session has captured human prompts.',
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, counts: {} }));
      });
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
  function runHook(payload: Record<string, unknown>): Promise<{ status: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.resolve('packages/myco/src/cli.ts'), 'hook', 'user-prompt-submit', '--symbiont', 'claude-code'],
        {
          cwd: projectRoot,
          env: { ...process.env, MYCO_NO_AUTO_SPAWN: '1', MYCO_HOME: mycoHome },
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  it('a drop-rule fire posts DELETE with {expect_empty: true} — never a bare delete', async () => {
    const sessionId = 'upsd-drop-accepted-001';
    const result = await runHook({
      // claude-code manifest drop rule: prompt_starts_with "<command-message>".
      prompt: '<command-message>compact</command-message>',
      session_id: sessionId,
      transcript_path: transcriptPath,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('user-prompt-submit: dropped');

    const deletes = requests.filter((r) => r.method === 'DELETE' && r.url === `/api/sessions/${sessionId}`);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body).toEqual({ expect_empty: true });
    // Accepted cleanup — no refusal message.
    expect(result.stderr).not.toContain('drop-delete refused');
  }, 20_000);

  it('a 409 session_not_empty refusal is stderr-logged and the hook still exits 0', async () => {
    const sessionId = 'upsd-drop-refused-001';
    const result = await runHook({
      prompt: '<command-message>compact</command-message>',
      session_id: sessionId,
      transcript_path: transcriptPath,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('user-prompt-submit: dropped');
    expect(result.stderr).toContain('drop-delete refused (session has captured content) — leaving cleanup to the maintenance sweep');

    const deletes = requests.filter((r) => r.method === 'DELETE' && r.url === `/api/sessions/${sessionId}`);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body).toEqual({ expect_empty: true });
  }, 20_000);
});
