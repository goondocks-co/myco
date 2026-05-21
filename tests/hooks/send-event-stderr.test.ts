import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveProjectBufferDir } from '@myco/grove/paths.js';

const TEST_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Regression: hook buffer-fallback used to be completely silent. A "session
 * not captured" investigation had to compare buffer-file mtimes against
 * transcript mtimes to discover that the hook had been writing to the
 * buffer for hours without ever reaching the daemon — exactly the failure
 * mode that hid the prod-daemon stop-responding bug for the entire morning
 * of 2026-05-15. Every fallback path must now leave a stderr trace so the
 * agent's log (or the user's terminal) captures it without a buffer-byte
 * audit.
 */
describe('hook send-event stderr observability', () => {
  function setupProject(): {
    projectRoot: string;
    vaultDir: string;
    mycoHome: string;
    groveId: string;
    transcriptPath: string;
  } {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-send-event-stderr-'));
    const vaultDir = path.join(projectRoot, '.myco');
    const mycoHome = path.join(projectRoot, 'home');
    const transcriptPath = path.join(projectRoot, 'transcript.jsonl');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(mycoHome, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      `[project]\nid = "${TEST_PROJECT_ID}"\nname = "send-event-stderr"\n`,
      'utf-8',
    );
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
    fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
    // Register the project in an isolated Grove so the hook's buffer
    // resolver finds (groveId, projectId) and writes to the global path.
    const grove = createGrove('test', mycoHome);
    registerProjectInGrove(grove.id, {
      projectId: TEST_PROJECT_ID,
      projectName: 'send-event-stderr',
      projectRoot,
    }, mycoHome);
    return { projectRoot, vaultDir, mycoHome, groveId: grove.id, transcriptPath };
  }

  it('logs to stderr when buffering a tool_use on transport failure (daemon unreachable)', () => {
    const { projectRoot, mycoHome, groveId, transcriptPath } = setupProject();

    try {
      // Isolated MYCO_HOME + no daemon.json + MYCO_NO_AUTO_SPAWN=1 means
      // capturePost's three-tier discovery (daemon.json → daemon.lock →
      // /health on canonical port) finds nothing reachable, so result.ok
      // is false with result.data undefined — the "transport-failure"
      // branch in classifyBufferFallback.
      const result = spawnSync(
        process.execPath,
        [path.resolve('packages/myco/src/cli.ts'), 'hook', 'post-tool-use', '--symbiont', 'codex'],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            MYCO_NO_AUTO_SPAWN: '1',
            MYCO_HOME: mycoHome,
          },
          input: JSON.stringify({
            session_id: 'sess-stderr-transport',
            transcript_path: transcriptPath,
            tool_name: 'Bash',
            tool_input: { command: 'pwd' },
            tool_output: 'ok',
          }),
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('[myco] post-tool-use buffered');
      expect(result.stderr).toContain('session=sess-stderr-transport');
      // Reason classification: no daemon.json → result.ok=false, result.data=undefined.
      expect(result.stderr).toContain('transport-failure');

      // The buffer landed under the global Grove tree, not the legacy
      // `<projectRoot>/.myco/buffer/` path.
      const bufferPath = path.join(
        resolveProjectBufferDir(groveId, TEST_PROJECT_ID, mycoHome),
        'sess-stderr-transport.jsonl',
      );
      expect(fs.existsSync(bufferPath)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
