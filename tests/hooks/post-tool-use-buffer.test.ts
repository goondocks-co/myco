import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('post-tool-use hook buffer fallback', () => {
  it('writes replayable tool_name/tool_input fields when the daemon is unavailable', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-post-tool-buffer-'));
    const vaultDir = path.join(projectRoot, '.myco');
    const transcriptPath = path.join(projectRoot, 'transcript.jsonl');

    try {
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(
        path.join(vaultDir, 'project.toml'),
        '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "post-tool-buffer"\n',
        'utf-8',
      );
      fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
      fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');

      const result = spawnSync(
        process.execPath,
        [path.resolve('packages/myco/src/cli.ts'), 'hook', 'post-tool-use', '--symbiont', 'codex'],
        {
          cwd: projectRoot,
          env: { ...process.env, MYCO_NO_AUTO_SPAWN: '1' },
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

      const bufferPath = path.join(vaultDir, 'buffer', 'session-buffer-1.jsonl');
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
