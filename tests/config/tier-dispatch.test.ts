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
      daemon: { log_level: 'debug', log_retention_days: 14, update_channel: 'stable' },
    });

    const expected = resolveGlobalConfigPath();
    expect(expected.endsWith('config.yaml')).toBe(true);
    expect(fs.existsSync(expected)).toBe(true);

    const written = YAML.parse(fs.readFileSync(expected, 'utf-8'));
    expect(written.daemon.log_level).toBe('debug');
    expect(written.daemon.log_retention_days).toBe(14);
  });

  it('saveMachineConfig does NOT write to a Grove config file', () => {
    saveMachineConfig({
      ...loadMachineConfig(),
      daemon: { log_level: 'info', log_retention_days: 7, update_channel: 'stable' },
    });

    const grovePath = resolveGroveConfigPath('grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(fs.existsSync(grovePath)).toBe(false);
  });

  it('saveGroveConfig writes ~/.myco/groves/<id>/grove.yaml', () => {
    const groveId = 'grove_1111111111111111111111111111aaaa';
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
    saveGroveConfig('grove_2222222222222222222222222222aaaa', {
      ...loadGroveConfig('grove_2222222222222222222222222222aaaa'),
      backup: { dir: '/tmp/x', retention_days: 7 },
    });

    const machinePath = resolveGlobalConfigPath();
    // Machine config either doesn't exist or doesn't have backup.dir
    if (fs.existsSync(machinePath)) {
      const machineDoc = YAML.parse(fs.readFileSync(machinePath, 'utf-8')) ?? {};
      expect(machineDoc.backup).toBeUndefined();
    }
  });

  it('save{Machine,Grove}Config write to distinct files for distinct daemon fields', () => {
    saveMachineConfig({
      ...loadMachineConfig(),
      // Machine tier owns daemon.log_level / log_retention_days / update_channel.
      daemon: { log_level: 'info', log_retention_days: 7, update_channel: 'beta' },
    });
    saveGroveConfig('grove_3333333333333333333333333333aaaa', {
      ...loadGroveConfig('grove_3333333333333333333333333333aaaa'),
      // Grove tier owns daemon.stale_session_threshold_ms.
      daemon: { stale_session_threshold_ms: 60_000 },
    });

    const machineDoc = YAML.parse(fs.readFileSync(resolveGlobalConfigPath(), 'utf-8'));
    const groveDoc = YAML.parse(fs.readFileSync(resolveGroveConfigPath('grove_3333333333333333333333333333aaaa'), 'utf-8'));

    expect(machineDoc.daemon.update_channel).toBe('beta');
    expect(machineDoc.daemon.stale_session_threshold_ms).toBeUndefined();
    expect(groveDoc.daemon.stale_session_threshold_ms).toBe(60_000);
    expect(groveDoc.daemon.update_channel).toBeUndefined();
  });

  it('saveConfig retains caller-set Grove-tier fields in myco.yaml while the project is UNBOUND', () => {
    // Seed a sparse-but-valid project file so loadConfig succeeds. No
    // project.toml → no Grove binding. RC-3 semantics: Grove-tier values on
    // an unbound project are RETAINED in myco.yaml — there is no Grove file
    // to migrate them into, so dropping them would silently destroy them.
    // The next Grove-bound load lifts them into grove config and strips them.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-project-'));
    try {
      const seedYaml = 'version: 3\n';
      fs.writeFileSync(path.join(projectDir, 'myco.yaml'), seedYaml, 'utf-8');

      const config = loadConfig(projectDir);
      saveConfig(projectDir, {
        ...config,
        // Grove tier — retained until a Grove binds. Unknown keys
        // (retention_days, github_repo, …) are still stripped by the schema.
        backup: { dir: '/tmp/bad', retention_days: 30 },
        team: { enabled: true, github_repo: 'acme/x', branch: 'main', api_token: 'secret' },
        appearance: { theme: 'plum', mode: 'light', font: 'jetbrains-mono', density: 'compact' },
      } as MycoConfig);

      const persisted = YAML.parse(fs.readFileSync(path.join(projectDir, 'myco.yaml'), 'utf-8'));
      expect(persisted.backup?.dir).toBe('/tmp/bad');
      expect(persisted.team?.enabled).toBe(true);
      expect(persisted.appearance?.theme).toBe('plum');
      // Machine-tier + legacy fields still never survive in the project file.
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
      daemon: { log_level: 'info', log_retention_days: 7, update_channel: 'beta' },
    });
    saveGroveConfig('grove_4444444444444444444444444444aaaa', {
      ...loadGroveConfig('grove_4444444444444444444444444444aaaa'),
      backup: { dir: '/tmp/readback', retention_days: 21 },
    });

    const machine = loadMachineConfig();
    const grove = loadGroveConfig('grove_4444444444444444444444444444aaaa');

    expect(machine.daemon.update_channel).toBe('beta');
    expect(machine.daemon.log_retention_days).toBe(7);
    expect(grove.backup?.dir).toBe('/tmp/readback');
  });
});
