import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function spawnHook(symbiont: string, stdin: object, projectRoot: string) {
  return spawnSync(
    process.execPath,
    [path.resolve('packages/myco/src/cli.ts'), 'hook', 'pre-tool-use', '--symbiont', symbiont],
    {
      cwd: projectRoot,
      env: { ...process.env, MYCO_NO_AUTO_SPAWN: '1' },
      input: JSON.stringify(stdin),
      encoding: 'utf-8',
    },
  );
}

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pre-tool-'));
  const vault = path.join(root, '.myco');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(
    path.join(vault, 'project.toml'),
    '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "pre-tool-test"\n',
    'utf-8',
  );
  fs.writeFileSync(path.join(vault, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('pre-tool-use hook (integration, no daemon)', () => {
  it('claude-code Read with a path emits empty stdout when the daemon is down', () => {
    const { root, cleanup } = makeProject();
    try {
      const result = spawnHook(
        'claude-code',
        {
          session_id: 'sess-1',
          tool_name: 'Read',
          tool_input: { file_path: '/abs/foo.ts' },
        },
        root,
      );
      expect(result.status).toBe(0);
      // Daemon is unreachable; the hook should still exit cleanly with empty stdout.
      expect(result.stdout).toBe('');
    } finally {
      cleanup();
    }
  });

  it('claude-code Write (non-read tool) emits empty stdout', () => {
    const { root, cleanup } = makeProject();
    try {
      const result = spawnHook(
        'claude-code',
        {
          session_id: 'sess-1',
          tool_name: 'Write',
          tool_input: { file_path: '/abs/foo.ts', content: 'x' },
        },
        root,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      cleanup();
    }
  });

  it('codex Bash with non-read command emits empty stdout (no false-positive injection)', () => {
    const { root, cleanup } = makeProject();
    try {
      const result = spawnHook(
        'codex',
        {
          session_id: 'sess-1',
          tool_name: 'Bash',
          tool_input: { command: 'ls -la' },
        },
        root,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      cleanup();
    }
  });

  it('unknown symbiont gracefully emits empty stdout', () => {
    const { root, cleanup } = makeProject();
    try {
      const result = spawnHook(
        'does-not-exist',
        {
          session_id: 'sess-1',
          tool_name: 'Read',
          tool_input: { file_path: '/abs/foo.ts' },
        },
        root,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      cleanup();
    }
  });
});
