import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  function setupProject(): { projectRoot: string; vaultDir: string; transcriptPath: string } {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-send-event-stderr-'));
    const vaultDir = path.join(projectRoot, '.myco');
    const transcriptPath = path.join(projectRoot, 'transcript.jsonl');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "send-event-stderr"\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
    fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
    return { projectRoot, vaultDir, transcriptPath };
  }

  it('logs to stderr when buffering a tool_use on transport failure (daemon unreachable)', () => {
    const { projectRoot, vaultDir, transcriptPath } = setupProject();

    try {
      // No daemon.json + MYCO_NO_AUTO_SPAWN=1 means capturePost short-circuits
      // to ok=false without an HTTP error envelope — the "transport-failure"
      // branch in classifyBufferFallback.
      const result = spawnSync(
        process.execPath,
        [path.resolve('packages/myco/src/cli.ts'), 'hook', 'post-tool-use', '--symbiont', 'codex'],
        {
          cwd: projectRoot,
          env: { ...process.env, MYCO_NO_AUTO_SPAWN: '1' },
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

      // And the buffer should still have the event (the durability path is unchanged).
      const bufferPath = path.join(vaultDir, 'buffer', 'sess-stderr-transport.jsonl');
      expect(fs.existsSync(bufferPath)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
