import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DoctorCheck, checkSymbiontEdgeCases, isSymbiontRegistered, runChecks } from '@myco/cli/doctor';
import { loadManifests } from '@myco/symbionts/detect';

function findManifest(name: string) {
  const manifest = loadManifests().find((entry) => entry.name === name);
  expect(manifest, `manifest ${name} should exist`).toBeDefined();
  return manifest!;
}

describe('runChecks', () => {
  it('returns vault check failure when myco.yaml missing', async () => {
    const checks = await runChecks('/tmp/nonexistent-vault-' + Date.now());
    const vaultCheck = checks.find((c) => c.name === 'Vault');
    expect(vaultCheck).toBeDefined();
    expect(vaultCheck!.status).toBe('fail');
  });

  it('returns all expected check names', async () => {
    const checks = await runChecks('/tmp/nonexistent-vault-' + Date.now());
    const names = checks.map((c) => c.name);
    expect(names).toContain('Vault');
    expect(names).toContain('Database');
    expect(names).toContain('Embeddings');
    expect(names).toContain('Agents');
    expect(names).toContain('Daemon');
  });
});

describe('Edge-case detector (R4.7)', () => {
  function withFakeHome<T>(fn: (home: string) => T): T {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-edge-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      return fn(home);
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it('flags cursor settings containing a shell-cd prefix', async () => {
    await withFakeHome(async (home) => {
      const cursor = path.join(home, '.cursor', 'settings.json');
      fs.mkdirSync(path.dirname(cursor), { recursive: true });
      fs.writeFileSync(cursor, JSON.stringify({
        hooks: { sessionStart: [{ command: 'cd "${CURSOR_PROJECT_DIR:-.}" && node /Users/me/.myco/launcher.cjs hook session-start --symbiont cursor' }] },
      }), 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const fails = rows.filter((c) => c.status === 'fail');
      expect(fails.some((c) => c.detail.includes('shell-cd prefix'))).toBe(true);
    });
  });

  it('flags claude hook groups missing a matcher field', async () => {
    await withFakeHome(async (home) => {
      const claude = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(claude), { recursive: true });
      fs.writeFileSync(claude, JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ command: 'node x' }] }] }, // missing matcher
      }), 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const fails = rows.filter((c) => c.status === 'fail');
      expect(fails.some((c) => c.detail.includes('missing `matcher`'))).toBe(true);
    });
  });

  it('flags hybrid-TOML codex config (file starts with JSON brace)', async () => {
    await withFakeHome(async (home) => {
      const codex = path.join(home, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(codex), { recursive: true });
      fs.writeFileSync(codex, '{\n  "hooks": {}\n}\n', 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const fails = rows.filter((c) => c.status === 'fail');
      expect(fails.some((c) => c.detail.includes('starts with JSON'))).toBe(true);
    });
  });

  it('emits ok row when no edge cases are present', async () => {
    await withFakeHome(async () => {
      const rows = await checkSymbiontEdgeCases();
      expect(rows.length).toBeGreaterThan(0);
      // First (and likely only) row when nothing is wrong: the ok summary.
      expect(rows[0]!.status).toBe('ok');
      expect(rows[0]!.detail).toContain('No known broken-edge states');
    });
  });
});

describe('isSymbiontRegistered', () => {
  it('treats Pi plugin-file hooks as a valid registration surface', () => {
    const manifest = findManifest('pi');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-pi-'));
    try {
      const pluginPath = path.join(projectRoot, manifest.registration!.hooksTarget!);
      fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
      fs.writeFileSync(pluginPath, '// myco:plugin-marker:pi\n', 'utf-8');

      expect(isSymbiontRegistered({
        manifest,
        binaryFound: false,
        configDirFound: true,
      }, projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('treats Windsurf hook JSON as a valid registration surface', () => {
    const manifest = findManifest('windsurf');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-windsurf-'));
    try {
      const hooksPath = path.join(projectRoot, manifest.registration!.hooksTarget!);
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          pre_user_prompt: [
            {
              command: 'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && node .agents/myco-run.cjs hook user-prompt-submit --symbiont windsurf',
            },
          ],
        },
      }), 'utf-8');

      expect(isSymbiontRegistered({
        manifest,
        binaryFound: false,
        configDirFound: true,
      }, projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
