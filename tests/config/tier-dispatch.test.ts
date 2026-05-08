/**
 * Tier-dispatch tests — verify each tier-config helper writes to (and
 * reads from) the right tier file. A regression here would mean
 * Settings/Grove/System UI saves silently land on the wrong YAML.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  loadMachineConfig,
  saveMachineConfig,
  loadGroveConfig,
  saveGroveConfig,
  loadConfig,
  saveConfig,
} from '@myco/config/loader';
import type { MycoConfig } from '@myco/config/schema';
import {
  resolveGlobalConfigPath,
  resolveGroveConfigPath,
} from '@myco/grove/paths';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

describe('Tier dispatch', () => {
  let mycoHome: string;
  let previousMycoHome: string | undefined;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tier-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
    if (previousMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousMycoHome;
    }
  });

  it('saveMachineConfig writes ~/.myco/config.yaml', () => {
    saveMachineConfig({
      ...loadMachineConfig(),
      daemon: { port: 9999, log_level: 'debug', log_retention_days: 14, update_channel: 'stable' },
    });

    const expected = resolveGlobalConfigPath();
    expect(expected.endsWith('config.yaml')).toBe(true);
    expect(fs.existsSync(expected)).toBe(true);

    const written = YAML.parse(fs.readFileSync(expected, 'utf-8'));
    expect(written.daemon.port).toBe(9999);
    expect(written.daemon.log_level).toBe('debug');
  });

  it('saveMachineConfig does NOT write to a Grove config file', () => {
    saveMachineConfig({
      ...loadMachineConfig(),
      daemon: { port: 8888, log_level: 'info', log_retention_days: 7, update_channel: 'stable' },
    });

    const grovePath = resolveGroveConfigPath('any-id');
    expect(fs.existsSync(grovePath)).toBe(false);
  });

  it('saveGroveConfig writes ~/.myco/groves/<id>/grove.yaml', () => {
    const groveId = 'gv-test-123';
    saveGroveConfig(groveId, {
      ...loadGroveConfig(groveId),
      backup: { dir: '/tmp/grove-backup', retention_days: 30 },
    });

    const expected = resolveGroveConfigPath(groveId);
    expect(expected.endsWith(`groves/${groveId}/grove.yaml`)).toBe(true);
    expect(fs.existsSync(expected)).toBe(true);

    const written = YAML.parse(fs.readFileSync(expected, 'utf-8'));
    expect(written.backup.dir).toBe('/tmp/grove-backup');
  });

  it('saveGroveConfig does NOT write to the machine config file', () => {
    saveGroveConfig('gv-isolated', {
      ...loadGroveConfig('gv-isolated'),
      backup: { dir: '/tmp/x', retention_days: 7 },
    });

    const machinePath = resolveGlobalConfigPath();
    // Machine config either doesn't exist or doesn't have backup.dir
    if (fs.existsSync(machinePath)) {
      const machineDoc = YAML.parse(fs.readFileSync(machinePath, 'utf-8')) ?? {};
      expect(machineDoc.backup).toBeUndefined();
    }
  });

  it('save{Machine,Grove}Config write to distinct files for the same field name', () => {
    saveMachineConfig({
      ...loadMachineConfig(),
      daemon: { port: 7777, log_level: 'info', log_retention_days: 7, update_channel: 'stable' },
    });
    saveGroveConfig('gv-distinct', {
      ...loadGroveConfig('gv-distinct'),
      // Grove tier owns daemon.stale_session_threshold_ms
      daemon: { stale_session_threshold_ms: 60_000 },
    });

    const machineDoc = YAML.parse(fs.readFileSync(resolveGlobalConfigPath(), 'utf-8'));
    const groveDoc = YAML.parse(fs.readFileSync(resolveGroveConfigPath('gv-distinct'), 'utf-8'));

    expect(machineDoc.daemon.port).toBe(7777);
    expect(machineDoc.daemon.stale_session_threshold_ms).toBeUndefined();
    expect(groveDoc.daemon.stale_session_threshold_ms).toBe(60_000);
    expect(groveDoc.daemon.port).toBeUndefined();
  });

  it('saveConfig strips Grove/Machine tier fields out of the project file (ProjectConfigSchema)', () => {
    // Seed a sparse-but-valid project file so loadConfig succeeds.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-project-'));
    try {
      const seedYaml = 'version: 3\n';
      fs.writeFileSync(path.join(projectDir, 'myco.yaml'), seedYaml, 'utf-8');

      const config = loadConfig(projectDir);
      // Hand back a "full" MycoConfig with stray tier-foreign fields.
      // saveConfig should drop them before persisting myco.yaml.
      saveConfig(projectDir, {
        ...config,
        // Grove tier — should NOT survive into project file.
        backup: { dir: '/tmp/bad', retention_days: 30 },
        team: { enabled: true, github_repo: 'acme/x', branch: 'main', api_token: 'secret' },
      } as MycoConfig);

      const persisted = YAML.parse(fs.readFileSync(path.join(projectDir, 'myco.yaml'), 'utf-8'));
      expect(persisted.backup).toBeUndefined();
      expect(persisted.team).toBeUndefined();
      expect(persisted.daemon).toBeUndefined();
      expect(persisted.update).toBeUndefined();
      // Project-tier shape preserved.
      expect(persisted.version).toBe(3);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('loadMachineConfig and loadGroveConfig read from their own tier files only', () => {
    saveMachineConfig({
      ...loadMachineConfig(),
      daemon: { port: 6666, log_level: 'info', log_retention_days: 7, update_channel: 'beta' },
    });
    saveGroveConfig('gv-readback', {
      ...loadGroveConfig('gv-readback'),
      backup: { dir: '/tmp/readback', retention_days: 21 },
    });

    const machine = loadMachineConfig();
    const grove = loadGroveConfig('gv-readback');

    expect(machine.daemon.port).toBe(6666);
    expect(machine.daemon.update_channel).toBe('beta');
    expect(grove.backup?.dir).toBe('/tmp/readback');
  });
});
