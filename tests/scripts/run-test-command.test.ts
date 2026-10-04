import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-command-gate-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('non-Bun test command temp boundary', () => {
  for (const escape of [false, true]) {
    it(`contains command fixtures and ${escape ? 'fails escaped entries' : 'removes its root'}`, () => {
      const parent = fs.mkdtempSync(path.join(scratch, 'parent-'));
      const script = `
        const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
        const root = os.tmpdir();
        fs.mkdtempSync(path.join(root, 'myco-screen-fixture-'));
        if (${escape}) fs.writeFileSync(path.join(path.dirname(root), 'myco-command-escaped'), 'retain');
        console.log('TEMP_PROBE ' + JSON.stringify({ root, home: os.homedir(), codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }));
      `;
      const result = spawnSync('node', ['scripts/run-test-command.mjs', 'node', '-e', script], {
        env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent }, encoding: 'utf8',
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: escape ? 1 : 0, stderr: escape ? expect.stringContaining('FAIL: test temp entries escaped') : '' });
      const probe = JSON.parse(result.stdout.match(/^TEMP_PROBE (.+)$/m)![1]!) as { root: string; home: string; codex: string; claude: string };
      expect(path.dirname(probe.root)).toBe(parent);
      expect(path.dirname(probe.home)).toBe(probe.root);
      expect(probe.codex).toBe(path.join(probe.home, '.codex'));
      expect(probe.claude).toBe(path.join(probe.home, '.claude'));
      expect(fs.readdirSync(parent)).toEqual(escape ? ['myco-command-escaped'] : []);
    });
  }
});
