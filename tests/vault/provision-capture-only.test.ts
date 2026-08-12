import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import fs, { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ensureProjectVault } from '../../packages/myco/src/vault/provision';

let dir: string | null = null;
let priorMycoHome: string | undefined;

beforeEach(() => {
  priorMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mkdtempSync(join(tmpdir(), 'prov-home-'));
});
afterEach(() => {
  if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = priorMycoHome;
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (process.env.MYCO_HOME) rmSync(process.env.MYCO_HOME, { recursive: true, force: true });
  dir = null;
});

describe('ensureProjectVault capture-only default', () => {
  it('writes local.yaml with the four capability master gates off', () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    ensureProjectVault(dir);
    const localPath = join(dir, '.myco', 'local.yaml');
    expect(existsSync(localPath)).toBe(true);
    const local = parse(readFileSync(localPath, 'utf-8')) as any;
    expect(local.cortex.enabled).toBe(false);
    expect(local.cortex.canopy.enabled).toBe(false);
    expect(local.skills.enabled).toBe(false);
    expect(local.vault_evolution.enabled).toBe(false);
  });

  it('is idempotent — second call leaves local.yaml unchanged', () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    ensureProjectVault(dir);
    const localPath = join(dir, '.myco', 'local.yaml');
    const firstContent = readFileSync(localPath, 'utf-8');
    const firstMtime = fs.statSync(localPath).mtimeMs;

    ensureProjectVault(dir);
    const secondContent = readFileSync(localPath, 'utf-8');
    expect(secondContent).toBe(firstContent);
    // mtime unchanged — saveLocalConfig uses write-if-changed semantics
    expect(fs.statSync(localPath).mtimeMs).toBe(firstMtime);
  });

  it('myco.yaml is written last — absent myco.yaml triggers cold path self-heal', () => {
    // Simulates a mid-provision crash: vault dir exists, local.yaml written
    // (capture-only gates set), but myco.yaml never landed. The next call to
    // ensureProjectVault must re-run the cold path and write all files.
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    // First provision
    const first = ensureProjectVault(dir);
    expect(first.created).toBe(true);

    // Simulate crash: remove myco.yaml (the sentinel) but leave local.yaml
    const mycoYaml = join(dir, '.myco', 'myco.yaml');
    unlinkSync(mycoYaml);
    expect(existsSync(mycoYaml)).toBe(false);
    expect(existsSync(join(dir, '.myco', 'local.yaml'))).toBe(true);

    // Cold path re-runs and self-heals — myco.yaml is re-created
    const second = ensureProjectVault(dir);
    expect(second.created).toBe(true);
    expect(existsSync(mycoYaml)).toBe(true);

    // local.yaml still reflects capture-only (unchanged by re-provision)
    const local = parse(readFileSync(join(dir, '.myco', 'local.yaml'), 'utf-8')) as any;
    expect(local.cortex.enabled).toBe(false);
    expect(local.vault_evolution.enabled).toBe(false);
  });
});

describe('reseedCaptureOnly seeds only absent gate keys', () => {
  it('force re-admission preserves a capability the user explicitly enabled', () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    ensureProjectVault(dir);
    const localPath = join(dir, '.myco', 'local.yaml');
    // User promotes the project (capability panel writes at local scope).
    const promoted = parse(readFileSync(localPath, 'utf-8')) as any;
    promoted.cortex.canopy.enabled = true;
    fs.writeFileSync(localPath, `cortex:\n  enabled: false\n  canopy:\n    enabled: true\nskills:\n  enabled: false\nvault_evolution:\n  enabled: false\n`);

    ensureProjectVault(dir, { force: true });

    const local = parse(readFileSync(localPath, 'utf-8')) as any;
    expect(local.cortex.canopy.enabled).toBe(true);
    expect(local.skills.enabled).toBe(false);
  });

  it('cold-path re-run (deleted myco.yaml) re-seeds only missing gates', () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    ensureProjectVault(dir);
    const localPath = join(dir, '.myco', 'local.yaml');
    fs.writeFileSync(localPath, `skills:\n  enabled: true\n`);
    // Crash-resume design: deleting the hot-path sentinel re-runs the cold path.
    unlinkSync(join(dir, '.myco', 'myco.yaml'));

    // The cold re-run also consumed no fresh-notice budget: the marker is
    // written only when every gate was freshly seeded.
    unlinkSync(join(dir, '.myco', '.capture-only-notice-pending'));
    ensureProjectVault(dir);

    const local = parse(readFileSync(localPath, 'utf-8')) as any;
    expect(local.skills.enabled).toBe(true);
    expect(local.cortex.enabled).toBe(false);
    expect(local.cortex.canopy.enabled).toBe(false);
    expect(local.vault_evolution.enabled).toBe(false);
    expect(existsSync(join(dir, '.myco', '.capture-only-notice-pending'))).toBe(false);
  });
});

describe('capture-only notice marker', () => {
  it('cold path writes the pending-notice marker for the daemon sweep', () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    const result = ensureProjectVault(dir);
    const markerPath = join(dir, '.myco', '.capture-only-notice-pending');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(marker.project_id).toBe(result.projectId);
  });

  it('hot path does not rewrite a consumed marker', () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    ensureProjectVault(dir);
    const markerPath = join(dir, '.myco', '.capture-only-notice-pending');
    unlinkSync(markerPath); // daemon sweep consumed it
    ensureProjectVault(dir);
    ensureProjectVault(dir, { force: true });
    expect(existsSync(markerPath)).toBe(false);
  });
});
