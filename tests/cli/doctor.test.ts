import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DoctorCheck, isSymbiontRegistered, runChecks } from '@myco/cli/doctor';
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
