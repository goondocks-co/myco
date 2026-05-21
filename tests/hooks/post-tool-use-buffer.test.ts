import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveProjectBufferDir } from '@myco/grove/paths.js';

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
        [path.resolve('packages/myco/src/cli.ts'), 'hook', 'post-tool-use', '--symbiont', 'codex'],
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
});
