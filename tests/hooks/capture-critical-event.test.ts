import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureCriticalEvent, shouldBufferFallback } from '@myco/hooks/send-event.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveProjectBufferDir } from '@myco/grove/paths.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';

const TEST_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * The hook-side buffer-fallback decision table over the daemon's honest
 * response contract (capture/event-policy.ts + send-event.ts). Every row:
 *
 *   !ok                                   → buffer
 *   ok + persisted:true                   → nothing
 *   ok + persisted:false + buffered:true  → nothing (daemon copy durable)
 *   ok + persisted:false + buffered:false → buffer (the honest fallback)
 *   ok + ignored + persisted present      → never buffer (ignored ≠ lost)
 *   ok with NO persisted field (legacy daemon / every /events/stop reply)
 *                                         → policy table's legacy columns
 *
 * Plus the central agent/origin enrichment of the buffered copy and the
 * fail-open guarantee (a throwing buffer write never propagates).
 */
describe('captureCriticalEvent — policy-driven buffer fallback', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let projectRoot: string;
  let vaultDir: string;
  let bufferDir: string;

  beforeAll(() => {
    sandbox = sandboxMycoHome('myco-capture-critical-');
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-capture-critical-proj-'));
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      `[project]\nid = "${TEST_PROJECT_ID}"\nname = "capture-critical"\n`,
      'utf-8',
    );
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
    const grove = createGrove('test', sandbox.mycoHome);
    registerProjectInGrove(grove.id, {
      projectId: TEST_PROJECT_ID,
      projectName: 'capture-critical',
      projectRoot,
    }, sandbox.mycoHome);
    bufferDir = resolveProjectBufferDir(grove.id, TEST_PROJECT_ID, sandbox.mycoHome);
  });

  afterAll(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    sandbox.restore();
  });

  function fakeClient(result: { ok: boolean; data?: unknown }): DaemonClient {
    return { capturePost: async () => result } as unknown as DaemonClient;
  }

  function bufferedLines(sessionId: string): Array<Record<string, unknown>> {
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(bufferPath)) return [];
    const raw = fs.readFileSync(bufferPath, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line));
  }

  async function run(opts: {
    sessionId: string;
    result: { ok: boolean; data?: unknown };
    postBody: Record<string, unknown>;
    bufferEvent: Record<string, unknown> | null;
  }) {
    return captureCriticalEvent({
      vaultDir,
      sessionId: opts.sessionId,
      hookName: 'test-hook',
      endpoint: '/events',
      postBody: opts.postBody,
      bufferEvent: opts.bufferEvent,
      client: fakeClient(opts.result),
    });
  }

  describe('decision-table unit rows (shouldBufferFallback)', () => {
    it('covers every row of the §3 decision table', () => {
      // Transport / timeout / non-2xx — always buffer.
      expect(shouldBufferFallback({ ok: false }, 'user_prompt')).toBe(true);
      expect(shouldBufferFallback({ ok: false, data: { error: 'x' } }, 'tool_use')).toBe(true);

      // Honest contract.
      expect(shouldBufferFallback({ ok: true, data: { ok: true, persisted: true } }, 'user_prompt')).toBe(false);
      expect(shouldBufferFallback({ ok: true, data: { ok: true, persisted: false, buffered: true } }, 'user_prompt')).toBe(false);
      expect(shouldBufferFallback({ ok: true, data: { ok: true, persisted: false, buffered: false } }, 'user_prompt')).toBe(true);

      // Contract-aware daemon's ignored — never buffer, even for types whose
      // LEGACY column buffers on ignored.
      expect(shouldBufferFallback({ ok: true, data: { ok: true, ignored: 'rule', persisted: false } }, 'user_prompt')).toBe(false);
      expect(shouldBufferFallback({ ok: true, data: { ok: true, ignored: 'duplicate', persisted: false } }, 'tool_failure')).toBe(false);

      // LEGACY daemon (no persisted field): exact per-type legacy behavior.
      expect(shouldBufferFallback({ ok: true, data: { ok: true, ignored: 'rule' } }, 'user_prompt')).toBe(true);
      expect(shouldBufferFallback({ ok: true, data: { ok: true, ignored: 'rule' } }, 'tool_use')).toBe(false);
      expect(shouldBufferFallback({ ok: true, data: { ok: true, ignored: 'rule' } }, 'tool_failure')).toBe(true);
      expect(shouldBufferFallback({ ok: true, data: { ok: true, ignored: 'invalid-session' } }, 'stop')).toBe(true);
      expect(shouldBufferFallback({ ok: true, data: { ok: true } }, 'user_prompt')).toBe(false);
      expect(shouldBufferFallback({ ok: true, data: { ok: true, batchId: 7 } }, 'user_prompt')).toBe(false);

      // /events/stop success: queued, no persisted field — never a fallback.
      expect(shouldBufferFallback({ ok: true, data: { ok: true, queued: true } }, 'stop')).toBe(false);
    });
  });

  it('buffers on transport failure (legacy behavior preserved)', async () => {
    const sessionId = 'ccev-transport-001';
    await run({
      sessionId,
      result: { ok: false },
      postBody: { type: 'tool_use', session_id: sessionId, agent: 'codex', tool_name: 'Bash' },
      bufferEvent: { type: 'tool_use', tool_name: 'Bash' },
    });
    expect(bufferedLines(sessionId)).toHaveLength(1);
  });

  it('does not buffer when the daemon persisted', async () => {
    const sessionId = 'ccev-persisted-001';
    await run({
      sessionId,
      result: { ok: true, data: { ok: true, persisted: true, batchId: 12 } },
      postBody: { type: 'user_prompt', session_id: sessionId, agent: 'claude-code', prompt: 'p' },
      bufferEvent: { type: 'user_prompt', prompt: 'p' },
    });
    expect(bufferedLines(sessionId)).toHaveLength(0);
  });

  it('does not double-buffer when the daemon failed to persist but holds a buffered copy', async () => {
    const sessionId = 'ccev-daemon-buffered-001';
    await run({
      sessionId,
      result: { ok: true, data: { ok: true, persisted: false, buffered: true } },
      postBody: { type: 'tool_use', session_id: sessionId, agent: 'claude-code', tool_name: 'Bash' },
      bufferEvent: { type: 'tool_use', tool_name: 'Bash' },
    });
    expect(bufferedLines(sessionId)).toHaveLength(0);
  });

  it('buffers the one honest-fallback case: persisted:false with no daemon-side copy', async () => {
    const sessionId = 'ccev-honest-fallback-001';
    await run({
      sessionId,
      result: { ok: true, data: { ok: true, persisted: false, buffered: false } },
      postBody: { type: 'tool_use', session_id: sessionId, agent: 'claude-code', tool_name: 'Bash' },
      bufferEvent: { type: 'tool_use', tool_name: 'Bash' },
    });
    expect(bufferedLines(sessionId)).toHaveLength(1);
  });

  it('never buffers a contract-aware daemon ignore, even for user_prompt', async () => {
    const sessionId = 'ccev-new-ignored-001';
    await run({
      sessionId,
      result: { ok: true, data: { ok: true, ignored: 'rule', persisted: false } },
      postBody: { type: 'user_prompt', session_id: sessionId, agent: 'claude-code', prompt: 'p' },
      bufferEvent: { type: 'user_prompt', prompt: 'p' },
    });
    expect(bufferedLines(sessionId)).toHaveLength(0);
  });

  describe('LEGACY daemon (no persisted field) reproduces today\'s exact per-hook behavior', () => {
    it('user_prompt buffers on ignored', async () => {
      const sessionId = 'ccev-legacy-prompt-001';
      await run({
        sessionId,
        result: { ok: true, data: { ok: true, ignored: 'rule' } },
        postBody: { type: 'user_prompt', session_id: sessionId, agent: 'claude-code', prompt: 'p' },
        bufferEvent: { type: 'user_prompt', prompt: 'p' },
      });
      expect(bufferedLines(sessionId)).toHaveLength(1);
    });

    it('tool_use does NOT buffer on ignored (direct replay would resurrect a dropped tool)', async () => {
      const sessionId = 'ccev-legacy-tool-001';
      await run({
        sessionId,
        result: { ok: true, data: { ok: true, ignored: 'rule' } },
        postBody: { type: 'tool_use', session_id: sessionId, agent: 'claude-code', tool_name: 'Bash' },
        bufferEvent: { type: 'tool_use', tool_name: 'Bash' },
      });
      expect(bufferedLines(sessionId)).toHaveLength(0);
    });

    it('stop buffers on ignored only when there is a summary (bufferEvent present)', async () => {
      const sessionId = 'ccev-legacy-stop-001';
      // /events/stop posts carry no `type`; the event type comes from the
      // bufferEvent — exactly the live stop hook's shape.
      await run({
        sessionId,
        result: { ok: true, data: { ok: true, ignored: 'invalid-session' } },
        postBody: { session_id: sessionId, agent: 'codex', last_assistant_message: 'answer' },
        bufferEvent: { type: 'stop', last_assistant_message: 'answer', agent: 'codex' },
      });
      expect(bufferedLines(sessionId)).toHaveLength(1);
    });

    it('stop without a summary never buffers (bufferEvent null), even on transport failure', async () => {
      const sessionId = 'ccev-legacy-stop-empty-001';
      await run({
        sessionId,
        result: { ok: false },
        postBody: { session_id: sessionId, agent: 'codex' },
        bufferEvent: null,
      });
      expect(bufferedLines(sessionId)).toHaveLength(0);
    });

    it('plain legacy ok (no persisted field, not ignored) does not buffer', async () => {
      const sessionId = 'ccev-legacy-ok-001';
      await run({
        sessionId,
        result: { ok: true, data: { ok: true, batchId: 3 } },
        postBody: { type: 'user_prompt', session_id: sessionId, agent: 'claude-code', prompt: 'p' },
        bufferEvent: { type: 'user_prompt', prompt: 'p' },
      });
      expect(bufferedLines(sessionId)).toHaveLength(0);
    });
  });

  describe('central agent/origin enrichment of the buffered copy', () => {
    it('stamps the POST body\'s agent onto a bufferEvent that lacks one', async () => {
      const sessionId = 'ccev-agent-merge-001';
      await run({
        sessionId,
        result: { ok: false },
        postBody: { type: 'tool_use', session_id: sessionId, agent: 'windsurf', tool_name: 'Bash' },
        bufferEvent: { type: 'tool_use', tool_name: 'Bash' },
      });
      const [event] = bufferedLines(sessionId);
      expect(event.agent).toBe('windsurf');
    });

    it('forwards origin from the POST body when the bufferEvent lacks it', async () => {
      const sessionId = 'ccev-origin-merge-001';
      await run({
        sessionId,
        result: { ok: false },
        postBody: { type: 'user_prompt', session_id: sessionId, agent: 'claude-code', prompt: 'p', origin: 'system' },
        bufferEvent: { type: 'user_prompt', prompt: 'p' },
      });
      const [event] = bufferedLines(sessionId);
      expect(event.origin).toBe('system');
    });

    it('keeps the bufferEvent\'s own origin when present (no clobber)', async () => {
      const sessionId = 'ccev-origin-keep-001';
      await run({
        sessionId,
        result: { ok: false },
        postBody: { type: 'user_prompt', session_id: sessionId, agent: 'claude-code', prompt: 'p', origin: 'human' },
        bufferEvent: { type: 'user_prompt', prompt: 'p', origin: 'agent_dispatch' },
      });
      const [event] = bufferedLines(sessionId);
      expect(event.origin).toBe('agent_dispatch');
    });
  });

  describe('fail-open', () => {
    it('a throwing buffer write never propagates out of captureCriticalEvent', async () => {
      // Force EventBuffer's mkdir to throw by planting a regular FILE where
      // a project's buffer dir should be — a registration whose buffer path
      // is unusable. The helper must trace to stderr and resolve normally.
      const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-capture-critical-broken-'));
      const brokenVault = path.join(brokenRoot, '.myco');
      fs.mkdirSync(brokenVault, { recursive: true });
      const brokenProjectId = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      fs.writeFileSync(
        path.join(brokenVault, 'project.toml'),
        `[project]\nid = "${brokenProjectId}"\nname = "broken-buffer"\n`,
        'utf-8',
      );
      fs.writeFileSync(path.join(brokenVault, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
      const grove = createGrove('broken', sandbox.mycoHome);
      registerProjectInGrove(grove.id, {
        projectId: brokenProjectId,
        projectName: 'broken-buffer',
        projectRoot: brokenRoot,
      }, sandbox.mycoHome);
      const brokenBufferDir = resolveProjectBufferDir(grove.id, brokenProjectId, sandbox.mycoHome);
      fs.mkdirSync(path.dirname(brokenBufferDir), { recursive: true });
      fs.writeFileSync(brokenBufferDir, 'not a directory', 'utf-8');

      try {
        const result = await captureCriticalEvent({
          vaultDir: brokenVault,
          sessionId: 'ccev-fail-open-001',
          hookName: 'test-hook',
          endpoint: '/events',
          postBody: { type: 'tool_use', session_id: 'ccev-fail-open-001', agent: 'codex', tool_name: 'Bash' },
          bufferEvent: { type: 'tool_use', tool_name: 'Bash' },
          client: fakeClient({ ok: false }),
        });
        expect(result.ok).toBe(false);
      } finally {
        fs.rmSync(brokenRoot, { recursive: true, force: true });
      }
    });
  });
});
