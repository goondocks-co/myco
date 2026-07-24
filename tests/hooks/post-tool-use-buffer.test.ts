import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveProjectBufferDir } from '@myco/grove/paths.js';
import { testPerUserLocksRoot } from '../helpers/per-user-lock-namespace.js';

const TEST_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('post-tool-use hook buffer fallback', () => {
  it('writes replayable tool_name/tool_input fields when the daemon is unavailable', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-post-tool-buffer-'));
    const vaultDir = path.join(projectRoot, '.myco');
    const mycoHome = path.join(projectRoot, 'home');
    const transcriptPath = path.join(projectRoot, 'transcript.jsonl');

    try {
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.mkdirSync(mycoHome, { recursive: true });
      fs.writeFileSync(
        path.join(vaultDir, 'project.toml'),
        `[project]\nid = "${TEST_PROJECT_ID}"\nname = "post-tool-buffer"\n`,
        'utf-8',
      );
      fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
      fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');

      // Register the project in an isolated Grove so the hook's
      // buffer-dir resolver finds a real (groveId, projectId) and writes
      // to the new global location. Without registration the hook drops
      // the event (no fallback) — the legacy `<projectRoot>/.myco/buffer/`
      // path no longer exists by design.
      const grove = createGrove('test', mycoHome);
      registerProjectInGrove(grove.id, {
        projectId: TEST_PROJECT_ID,
        projectName: 'post-tool-buffer',
        projectRoot,
      }, mycoHome);

      const result = spawnSync(
        process.execPath,
        [
          path.resolve('tests/helpers/capture-hook-helper.ts'),
          testPerUserLocksRoot,
          'post-tool-use',
          '--symbiont',
          'codex',
        ],
        {
          cwd: projectRoot,
          // Isolate MYCO_HOME so daemon discovery cannot reach a real
          // daemon listening on the developer's canonical port. Without
          // this, `getInfoAsync`'s lifecycle-lock + /health fallback
          // would find the prod daemon and POST instead of buffering.
          env: {
            ...process.env,
            MYCO_NO_AUTO_SPAWN: '1',
            MYCO_HOME: mycoHome,
          },
          input: JSON.stringify({
            session_id: 'session-buffer-1',
            transcript_path: transcriptPath,
            tool_name: 'Bash',
            tool_input: { command: 'pwd' },
            tool_output: 'ok',
          }),
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(0);

      const bufferDir = resolveProjectBufferDir(grove.id, TEST_PROJECT_ID, mycoHome);
      const bufferPath = path.join(bufferDir, 'session-buffer-1.jsonl');
      const line = fs.readFileSync(bufferPath, 'utf-8').trim();
      const event = JSON.parse(line);

      expect(event).toMatchObject({
        type: 'tool_use',
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
        output_preview: 'ok',
        transcript_path: transcriptPath,
      });
      expect(event.tool).toBeUndefined();
      expect(event.input).toBeUndefined();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('drops PostToolUse events that carry no tool_name (Antigravity non-tool steps)', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-post-tool-blank-'));
    const vaultDir = path.join(projectRoot, '.myco');
    const mycoHome = path.join(projectRoot, 'home');
    const transcriptPath = path.join(projectRoot, 'transcript.jsonl');

    try {
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.mkdirSync(mycoHome, { recursive: true });
      fs.writeFileSync(
        path.join(vaultDir, 'project.toml'),
        `[project]\nid = "${TEST_PROJECT_ID}"\nname = "post-tool-buffer"\n`,
        'utf-8',
      );
      fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
      fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');

      const grove = createGrove('test', mycoHome);
      registerProjectInGrove(grove.id, {
        projectId: TEST_PROJECT_ID,
        projectName: 'post-tool-buffer',
        projectRoot,
      }, mycoHome);

      const result = spawnSync(
        process.execPath,
        [
          path.resolve('tests/helpers/capture-hook-helper.ts'),
          testPerUserLocksRoot,
          'post-tool-use',
          '--symbiont',
          'antigravity',
        ],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            MYCO_NO_AUTO_SPAWN: '1',
            MYCO_HOME: mycoHome,
          },
          // Payload with no toolCall.name — Antigravity's "thinking" /
          // PreInvocation-tail steps emit PostToolUse fires with no
          // tool name. The hook MUST drop these (otherwise the buffer
          // accumulates blank rows that surface as empty activity
          // entries in the Sessions UI).
          //
          // Antigravity's manifest maps sessionId -> conversationId, so
          // we send the IDE-shape envelope (conversationId +
          // transcriptPath) and intentionally omit `toolCall`.
          input: JSON.stringify({
            conversationId: 'session-blank-1',
            transcriptPath,
          }),
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(0);

      const bufferDir = resolveProjectBufferDir(grove.id, TEST_PROJECT_ID, mycoHome);
      const bufferPath = path.join(bufferDir, 'session-blank-1.jsonl');
      // Buffer file should not exist OR should be empty — the event was
      // dropped before reaching the buffer.
      const bufferEmpty = !fs.existsSync(bufferPath) || fs.readFileSync(bufferPath, 'utf-8').trim().length === 0;
      expect(bufferEmpty).toBe(true);
      // stderr should carry the drop trace for observability.
      expect(result.stderr).toContain('post-tool-use dropped (no tool_name)');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
