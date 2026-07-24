import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveProjectBufferDir } from '@myco/grove/paths.js';
import { testPerUserLocksRoot } from '../helpers/per-user-lock-namespace.js';

const TEST_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * The Stop hook carries the turn's assistant response (`last_assistant_message`).
 * Unlike every other capture-critical hook it historically POSTed without a
 * buffer fallback, so a daemon that was down/restarting at Stop time silently
 * dropped the response — `reconcileBufferBatches` had a `stop`-event replay
 * branch (tests/daemon/reconciliation-stop.test.ts) but nothing ever produced
 * the buffered event. These tests pin the producer side.
 */
function runStopHook(opts: {
  projectRoot: string;
  mycoHome: string;
  input: Record<string, unknown>;
}) {
  return spawnSync(
    process.execPath,
    [
      path.resolve('tests/helpers/capture-hook-helper.ts'),
      testPerUserLocksRoot,
      'stop',
      '--symbiont',
      'codex',
    ],
    {
      cwd: opts.projectRoot,
      // Isolate MYCO_HOME + block auto-spawn so daemon discovery cannot reach a
      // real daemon — the POST fails and the hook must fall back to the buffer.
      env: { ...process.env, MYCO_NO_AUTO_SPAWN: '1', MYCO_HOME: opts.mycoHome },
      input: JSON.stringify(opts.input),
      encoding: 'utf-8',
    },
  );
}

function setupProject(): { projectRoot: string; mycoHome: string; transcriptPath: string; groveId: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stop-buffer-'));
  const vaultDir = path.join(projectRoot, '.myco');
  const mycoHome = path.join(projectRoot, 'home');
  const transcriptPath = path.join(projectRoot, 'transcript.jsonl');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, 'project.toml'),
    `[project]\nid = "${TEST_PROJECT_ID}"\nname = "stop-buffer"\n`,
    'utf-8',
  );
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
  fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
  const grove = createGrove('test', mycoHome);
  registerProjectInGrove(grove.id, { projectId: TEST_PROJECT_ID, projectName: 'stop-buffer', projectRoot }, mycoHome);
  return { projectRoot, mycoHome, transcriptPath, groveId: grove.id };
}

describe('stop hook buffer fallback', () => {
  it('buffers the assistant response as a replayable stop event when the daemon is unavailable', () => {
    const { projectRoot, mycoHome, transcriptPath, groveId } = setupProject();
    try {
      const result = runStopHook({
        projectRoot,
        mycoHome,
        input: {
          session_id: 'session-stop-buffer-1',
          transcript_path: transcriptPath,
          last_assistant_message: 'The final answer for this turn.',
        },
      });

      expect(result.status).toBe(0);

      const bufferPath = path.join(
        resolveProjectBufferDir(groveId, TEST_PROJECT_ID, mycoHome),
        'session-stop-buffer-1.jsonl',
      );
      expect(fs.existsSync(bufferPath)).toBe(true);

      const event = JSON.parse(fs.readFileSync(bufferPath, 'utf-8').trim());
      // Shape must match what reconciliation.replayEvent reads for `type:'stop'`.
      expect(event).toMatchObject({
        type: 'stop',
        last_assistant_message: 'The final answer for this turn.',
        transcript_path: transcriptPath,
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not buffer a stop event when there is no assistant response to recover', () => {
    const { projectRoot, mycoHome, transcriptPath, groveId } = setupProject();
    try {
      const result = runStopHook({
        projectRoot,
        mycoHome,
        input: { session_id: 'session-stop-empty-1', transcript_path: transcriptPath },
      });

      expect(result.status).toBe(0);

      const bufferPath = path.join(
        resolveProjectBufferDir(groveId, TEST_PROJECT_ID, mycoHome),
        'session-stop-empty-1.jsonl',
      );
      const bufferEmpty = !fs.existsSync(bufferPath) || fs.readFileSync(bufferPath, 'utf-8').trim().length === 0;
      expect(bufferEmpty).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
