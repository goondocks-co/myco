/**
 * RC-3 — Config tier write safety regression tests.
 *
 * Ports the five verified repros:
 *   rc3a — saveConfig destroyed grove-tier values on UNBOUND projects
 *   rc3b — wrong-tier writes returned 200 then vanished at merge time
 *   rc3c — an unknown key default-reverted a strict tier file; the next PUT
 *          wiped it
 *   rc3d — corrupt local.yaml re-enabled every capability (OFF-gates lost)
 *   rc3e — invalidateMergedConfigCache(vaultDir) was a structural no-op
 *          against `${vaultDir}::${groveId}` keys
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import {
  loadConfig,
  updateConfig,
  updateLocalConfig,
  saveLocalConfig,
  loadMergedConfig,
  invalidateMergedConfigCache,
  loadMachineConfig,
  setTierParseFailureListener,
  TierConfigUnreadableError,
} from '@myco/config/loader';
import { CURRENT_MIGRATION_VERSION } from '@myco/config/migrations';
import { clearProjectManifestCache } from '@myco/config/project-manifest';
import { CAPABILITIES, capabilityEnabled } from '@myco/config/capabilities';
import type { CapabilityId } from '@myco/config/scope';
import { getAtPath } from '@myco/utils/dot-path';
import {
  handlePutScopedConfig,
  handlePutMachineConfig,
  handleGetMachineConfig,
} from '@myco/daemon/api/config';
import { handleUpdateTaskConfig } from '@myco/daemon/api/agent-tasks';
import type { RouteRequest } from '@myco/daemon/router';
import type { MachineConfig } from '@myco/config/schema';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox';

describe('RC-3 — config tier write safety', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let mycoHome: string;
  let vaultDir: string;
  const groveId = 'grove_' + 'd'.repeat(32);

  function configPath(): string {
    return path.join(vaultDir, 'myco.yaml');
  }
  function localPath(): string {
    return path.join(vaultDir, 'local.yaml');
  }
  function machinePath(): string {
    return path.join(mycoHome, 'config.yaml');
  }
  function grovePath(): string {
    return path.join(mycoHome, 'groves', groveId, 'grove.yaml');
  }
  function writeProject(yaml: string): void {
    fs.writeFileSync(configPath(), yaml);
  }
  function readYaml(p: string): Record<string, unknown> {
    return (YAML.parse(fs.readFileSync(p, 'utf-8')) ?? {}) as Record<string, unknown>;
  }
  function bindGrove(): void {
    // Minimal project.toml that loadProjectManifest can resolve a grove.id from.
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      `[project]\nid = "proj_${'e'.repeat(32)}"\nname = "rc3-test"\n\n[grove]\nid = "${groveId}"\nslug = "rc3-grove"\nmode = "local"\n`,
    );
    clearProjectManifestCache();
  }

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-rc3-home-');
    mycoHome = sandbox.mycoHome;
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rc3-vault-'));
    invalidateMergedConfigCache();
    clearProjectManifestCache();
  });

  afterEach(() => {
    setTierParseFailureListener(null);
    sandbox.restore();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    invalidateMergedConfigCache();
    clearProjectManifestCache();
  });

  // -------------------------------------------------------------------------
  // rc3a — unbound retention + Grove-bind lift
  // -------------------------------------------------------------------------

  it('rc3a: unbound project retains user-set grove-tier values across an unrelated updateConfig', () => {
    writeProject([
      'version: 3',
      'team:',
      '  enabled: true',
      '  team_id: team-rc3',
      'backup:',
      '  dir: /tmp/rc3-backups',
      'agent:',
      '  model: claude-opus-4-6',
      '  tasks:',
      '    vault-evolve:',
      '      maxTurns: 7',
      'release_provenance:',
      '  enabled: true',
      '',
    ].join('\n'));

    // One unrelated project-tier write must not destroy grove-tier values.
    updateConfig(vaultDir, (config) => ({
      ...config,
      release_provenance: { ...config.release_provenance, enabled: false },
    }));

    const persisted = readYaml(configPath());
    expect((persisted.team as Record<string, unknown>).enabled).toBe(true);
    expect((persisted.team as Record<string, unknown>).team_id).toBe('team-rc3');
    expect((persisted.backup as Record<string, unknown>).dir).toBe('/tmp/rc3-backups');
    expect(getAtPath(persisted, 'agent.model')).toBe('claude-opus-4-6');
    expect(getAtPath(persisted, 'agent.tasks.vault-evolve.maxTurns')).toBe(7);
    expect(getAtPath(persisted, 'release_provenance.enabled')).toBe(false);
  });

  it('rc3a: binding a Grove lifts the retained values into grove.yaml and strips them from myco.yaml', () => {
    writeProject([
      'version: 3',
      'team:',
      '  enabled: true',
      '  team_id: team-rc3',
      'backup:',
      '  dir: /tmp/rc3-backups',
      'agent:',
      '  model: claude-opus-4-6',
      '  tasks:',
      '    vault-evolve:',
      '      maxTurns: 7',
      '',
    ].join('\n'));
    // Retention round-trip first (unbound).
    updateConfig(vaultDir, (config) => config);

    bindGrove();
    // The merged load resolves groveId from the manifest and runs migrateTiers.
    loadMergedConfig(vaultDir, { mycoHome });

    const grove = readYaml(grovePath());
    expect(getAtPath(grove, 'team.enabled')).toBe(true);
    expect(getAtPath(grove, 'team.team_id')).toBe('team-rc3');
    expect(getAtPath(grove, 'backup.dir')).toBe('/tmp/rc3-backups');
    expect(getAtPath(grove, 'agent.model')).toBe('claude-opus-4-6');
    expect(getAtPath(grove, 'agent.tasks.vault-evolve.maxTurns')).toBe(7);

    const persisted = readYaml(configPath());
    expect(persisted.team).toBeUndefined();
    expect(persisted.backup).toBeUndefined();
    expect(persisted.agent).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // rc3b — write surfaces consult the scope registry
  // -------------------------------------------------------------------------

  it('rc3b: wrong-tier scoped patches are rejected with a 400 listing the paths', async () => {
    writeProject('version: 3\n');

    // Grove-homed path at project scope.
    const project = await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      patch: { team: { enabled: true } },
    });
    expect(project.status).toBe(400);
    expect((project.body as Record<string, unknown>).error).toBe('scope_violation');
    expect((project.body as Record<string, unknown>).paths).toEqual(['team.enabled']);

    // Non-overridable (grove-locked) path at local scope.
    const local = await handlePutScopedConfig(vaultDir, {
      scope: 'local',
      patch: { embedding: { model: 'nomic-embed-text' } },
    });
    expect(local.status).toBe(400);
    expect((local.body as Record<string, unknown>).error).toBe('scope_violation');
    expect((local.body as Record<string, unknown>).paths).toEqual(['embedding.model']);
  });

  it('rc3b: clears of the same wrong-tier paths stay exempt (residue remains deletable)', async () => {
    writeProject('version: 3\nteam:\n  enabled: true\n');
    fs.writeFileSync(localPath(), 'embedding:\n  model: stale-model\n');

    const clearProject = await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      clear: ['team.enabled'],
    });
    expect(clearProject.status).toBeUndefined();

    const clearLocal = await handlePutScopedConfig(vaultDir, {
      scope: 'local',
      clear: ['embedding.model'],
    });
    expect(clearLocal.status).toBeUndefined();
    const localRaw = readYaml(localPath());
    // The leaf is gone (an empty parent object may remain — clears don't
    // prune parents on the local path).
    expect(getAtPath(localRaw, 'embedding.model')).toBeUndefined();
  });

  it('rc3b: tier PUTs reject patches for paths the tier does not own', async () => {
    const res = await handlePutMachineConfig({
      patch: { team: { enabled: true } },
    });
    expect(res.response.status).toBe(400);
    expect((res.response.body as Record<string, unknown>).error).toBe('scope_violation');
    expect((res.response.body as Record<string, unknown>).paths).toEqual(['team.enabled']);
  });

  it('rc3b: agent-tasks no-Grove fallback persists agent.tasks in myco.yaml', async () => {
    writeProject('version: 3\n');
    const req = {
      params: { id: 'vault-evolve' },
      query: {},
      body: { maxTurns: 9 },
    } as unknown as RouteRequest;

    const res = await handleUpdateTaskConfig(req, vaultDir, null);
    expect(res.status).toBe(200);

    const persisted = readYaml(configPath());
    expect(getAtPath(persisted, 'agent.tasks.vault-evolve.maxTurns')).toBe(9);
    // Retain-until-Grove-bind: the value persists in myco.yaml (where the
    // scope-aware merge deliberately ignores grove-homed strays); rc3a
    // covers the lift that makes it effective once a Grove binds.
  });

  // -------------------------------------------------------------------------
  // rc3c — strict tier files: salvage unknown keys, refuse corrupt writes
  // -------------------------------------------------------------------------

  it('rc3c: an unknown key in machine config is salvaged (known values honored, not defaults)', () => {
    fs.mkdirSync(path.dirname(machinePath()), { recursive: true });
    fs.writeFileSync(machinePath(), 'daemon:\n  log_level: debug\nfuture_key: 1\n');

    const machine = loadMachineConfig();
    expect(machine.daemon.log_level).toBe('debug');
  });

  it('rc3c: a machine PUT preserves the unknown key on disk and does not destroy values', async () => {
    fs.mkdirSync(path.dirname(machinePath()), { recursive: true });
    fs.writeFileSync(machinePath(), 'daemon:\n  log_level: debug\nfuture_key: 1\n');

    const res = await handlePutMachineConfig({
      patch: { daemon: { log_retention_days: 60 } },
    });
    expect(res.response.status).toBeUndefined();
    expect((res.response.body as MachineConfig).daemon.log_retention_days).toBe(60);

    const raw = readYaml(machinePath());
    expect(raw.future_key).toBe(1);
    expect(getAtPath(raw, 'daemon.log_level')).toBe('debug');
    expect(getAtPath(raw, 'daemon.log_retention_days')).toBe(60);
  });

  it('rc3c: a corrupt machine file makes the PUT 422 and leaves the file untouched', async () => {
    const corrupt = 'daemon: [unterminated\n';
    fs.mkdirSync(path.dirname(machinePath()), { recursive: true });
    fs.writeFileSync(machinePath(), corrupt);

    const res = await handlePutMachineConfig({
      patch: { daemon: { log_retention_days: 60 } },
    });
    expect(res.response.status).toBe(422);
    expect((res.response.body as Record<string, unknown>).error).toBe('tier_config_unreadable');
    expect(fs.readFileSync(machinePath(), 'utf-8')).toBe(corrupt);
  });

  // -------------------------------------------------------------------------
  // rc3d — corrupt local.yaml fails closed on capabilities
  // -------------------------------------------------------------------------

  it('rc3d: a corrupt local.yaml forces every capability master gate off', () => {
    writeProject('version: 3\n');
    // Capture-only project shape: every master gate explicitly off in
    // local.yaml — then the file gets corrupted.
    fs.writeFileSync(localPath(), [
      'cortex:',
      '  enabled: false',
      'skills:',
      '  enabled: false',
      'vault_evolution:',
      '  enabled: false',
      '',
    ].join('\n'));
    fs.writeFileSync(localPath(), '{ broken: yaml');

    const failures: Array<{ filePath: string; reason: string }> = [];
    setTierParseFailureListener((filePath, reason) => failures.push({ filePath, reason }));

    const merged = loadMergedConfig(vaultDir, { groveId: null, mycoHome });
    for (const id of Object.keys(CAPABILITIES) as CapabilityId[]) {
      expect(getAtPath(merged, CAPABILITIES[id].masterGate)).toBe(false);
      expect(capabilityEnabled(merged, id)).toBe(false);
    }
    expect(failures.some((f) => f.filePath === localPath())).toBe(true);
  });

  it('rc3d: a scalar-root local.yaml also fails closed; an empty one stays a no-op', () => {
    writeProject('version: 3\n');
    fs.writeFileSync(localPath(), 'sage');
    const merged = loadMergedConfig(vaultDir, { groveId: null, mycoHome });
    for (const id of Object.keys(CAPABILITIES) as CapabilityId[]) {
      expect(capabilityEnabled(merged, id)).toBe(false);
    }

    // Empty file: capabilities resolve to their declared defaults (every
    // current capability defaults on).
    fs.writeFileSync(localPath(), '');
    invalidateMergedConfigCache();
    const mergedEmpty = loadMergedConfig(vaultDir, { groveId: null, mycoHome });
    for (const id of Object.keys(CAPABILITIES) as CapabilityId[]) {
      expect(capabilityEnabled(mergedEmpty, id)).toBe(CAPABILITIES[id].defaultEnabled ?? true);
    }
  });

  // -------------------------------------------------------------------------
  // rc3e — per-vault merged-cache invalidation
  // -------------------------------------------------------------------------

  it('rc3e: invalidateMergedConfigCache(vaultDir) drops the grove-keyed entry (frozen-fingerprint A→B)', () => {
    const FIXED = new Date(1_700_000_000_000);
    const yamlA = `version: 3\nconfig_version: ${CURRENT_MIGRATION_VERSION}\nrelease_provenance:\n  production_refs:\n    - refs/tags/aaa\n`;
    const yamlB = yamlA.replace('refs/tags/aaa', 'refs/tags/bbb');
    expect(yamlA.length).toBe(yamlB.length); // same size — fingerprint can't see the change

    writeProject(yamlA);
    fs.utimesSync(configPath(), FIXED, FIXED);
    const first = loadMergedConfig(vaultDir, { groveId: null, mycoHome });
    expect(first.release_provenance.production_refs).toEqual(['refs/tags/aaa']);

    writeProject(yamlB);
    fs.utimesSync(configPath(), FIXED, FIXED);
    // Setup sanity: the frozen mtime+size really does serve the stale entry.
    const stale = loadMergedConfig(vaultDir, { groveId: null, mycoHome });
    expect(stale.release_provenance.production_refs).toEqual(['refs/tags/aaa']);

    invalidateMergedConfigCache(vaultDir);
    const fresh = loadMergedConfig(vaultDir, { groveId: null, mycoHome });
    expect(fresh.release_provenance.production_refs).toEqual(['refs/tags/bbb']);
  });

  // -------------------------------------------------------------------------
  // List-delta against sparse tier files
  // -------------------------------------------------------------------------

  it('list-delta on a sparse machine file keeps schema-default array members', async () => {
    // No machine file at all — capture.artifact_extensions exists only as
    // the schema default ['.md']. The op must compute against the defaulted
    // view and write the FULL resulting array.
    const res = await handlePutMachineConfig({
      addToList: [{ path: 'capture.artifact_extensions', values: ['.py'] }],
    });
    expect(res.response.status).toBeUndefined();

    const raw = readYaml(machinePath());
    expect(getAtPath(raw, 'capture.artifact_extensions')).toEqual(['.md', '.py']);
    const view = await handleGetMachineConfig();
    expect((view.body as { config: MachineConfig }).config.capture.artifact_extensions)
      .toEqual(['.md', '.py']);
  });
});

describe('RC-3: tier-parse-failure listener replay (boot ordering)', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-rc3-listener-');
  });

  afterEach(() => {
    setTierParseFailureListener(null);
    sandbox.restore();
  });

  function machineFile(): string {
    return path.join(sandbox.mycoHome, 'config.yaml');
  }

  it('replays failures recorded before the listener registers, and re-notifies after fix-then-recorrupt', () => {
    // The daemon loads config at boot BEFORE wiring its listener; a file
    // already corrupt at startup must still produce a notification.
    fs.mkdirSync(path.dirname(machineFile()), { recursive: true });
    fs.writeFileSync(machineFile(), ':\nnot yaml: [\n');
    loadMachineConfig(sandbox.mycoHome);

    // Filter to this test's file: earlier tests in this process may have
    // recorded failures for their own (still-existing) sandbox files.
    const seen: Array<{ filePath: string; reason: string }> = [];
    setTierParseFailureListener((filePath, reason) => {
      if (filePath === machineFile()) seen.push({ filePath, reason });
    });
    expect(seen.length).toBe(1);

    // A clean read clears the record…
    fs.writeFileSync(machineFile(), 'daemon:\n  log_level: debug\n');
    loadMachineConfig(sandbox.mycoHome);

    // …so re-corrupting the SAME file with the SAME failure shape notifies again.
    fs.writeFileSync(machineFile(), ':\nnot yaml: [\n');
    loadMachineConfig(sandbox.mycoHome);
    expect(seen.length).toBe(2);
  });
});

describe('F13 — local/project tier write paths refuse unparseable files', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let vaultDir: string;

  function configPath(): string {
    return path.join(vaultDir, 'myco.yaml');
  }
  function localPath(): string {
    return path.join(vaultDir, 'local.yaml');
  }

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-f13-home-');
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-f13-vault-'));
    fs.writeFileSync(configPath(), 'version: 3\n');
    invalidateMergedConfigCache();
    clearProjectManifestCache();
  });

  afterEach(() => {
    setTierParseFailureListener(null);
    sandbox.restore();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    invalidateMergedConfigCache();
    clearProjectManifestCache();
  });

  it('updateLocalConfig throws TierConfigUnreadableError on corrupt local.yaml and leaves the file untouched', () => {
    const corrupt = 'notifications: [unclosed\n  bad{{{\n';
    fs.writeFileSync(localPath(), corrupt);
    expect(() => updateLocalConfig(vaultDir, (local) => ({ ...local, maintenance: { auto_optimize: false } })))
      .toThrow(TierConfigUnreadableError);
    expect(fs.readFileSync(localPath(), 'utf-8')).toBe(corrupt);
  });

  it('saveLocalConfig throws on a non-mapping local.yaml root and leaves the file untouched', () => {
    const corrupt = '- a\n- list\n';
    fs.writeFileSync(localPath(), corrupt);
    expect(() => saveLocalConfig(vaultDir, { maintenance: { auto_optimize: false } }))
      .toThrow(TierConfigUnreadableError);
    expect(fs.readFileSync(localPath(), 'utf-8')).toBe(corrupt);
  });

  it('saveLocalConfig still writes a missing or empty local.yaml (greenfield unaffected)', () => {
    saveLocalConfig(vaultDir, { maintenance: { auto_optimize: false } });
    expect(getAtPath(YAML.parse(fs.readFileSync(localPath(), 'utf-8')), 'maintenance.auto_optimize')).toBe(false);

    fs.writeFileSync(localPath(), '');
    saveLocalConfig(vaultDir, { maintenance: { auto_optimize: true } });
    expect(getAtPath(YAML.parse(fs.readFileSync(localPath(), 'utf-8')), 'maintenance.auto_optimize')).toBe(true);
  });

  it('scoped PUT at local scope returns 422 and does not clobber a corrupt local.yaml', async () => {
    const corrupt = 'notifications: [unclosed\n  bad{{{\n';
    fs.writeFileSync(localPath(), corrupt);

    const res = await handlePutScopedConfig(vaultDir, {
      scope: 'local',
      patch: { notifications: { domains: { skills: { enabled: false } } } },
    });
    expect(res.status).toBe(422);
    expect((res.body as Record<string, unknown>).error).toBe('tier_config_unreadable');
    expect((res.body as Record<string, unknown>).file).toBe(localPath());
    expect(fs.readFileSync(localPath(), 'utf-8')).toBe(corrupt);
  });

  it('updateConfig throws on corrupt myco.yaml before writing (single project write gate)', () => {
    const corrupt = 'cortex: {unclosed\n';
    fs.writeFileSync(configPath(), corrupt);
    expect(() => updateConfig(vaultDir, (c) => c)).toThrow(TierConfigUnreadableError);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(corrupt);
  });

  it('comments-only local.yaml stays writable (null root holds no values to lose)', () => {
    fs.writeFileSync(localPath(), '# capture-only overrides\n');
    saveLocalConfig(vaultDir, { maintenance: { auto_optimize: false } });
    expect(getAtPath(YAML.parse(fs.readFileSync(localPath(), 'utf-8')), 'maintenance.auto_optimize')).toBe(false);
  });

  it('non-mapping myco.yaml roots surface as 422 tier_config_unreadable, not raw TypeErrors', async () => {
    for (const corrupt of ['# just a comment\n', 'scalar-root\n', '- a\n- list\n']) {
      fs.writeFileSync(configPath(), corrupt);
      invalidateMergedConfigCache();
      const res = await handlePutScopedConfig(vaultDir, {
        scope: 'project',
        patch: { cortex: { enabled: true } },
      });
      expect(res.status).toBe(422);
      expect((res.body as Record<string, unknown>).error).toBe('tier_config_unreadable');
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(corrupt);
    }
  });

  it('scoped PUT at project scope returns 422 and does not clobber a corrupt myco.yaml', async () => {
    const corrupt = 'cortex: {unclosed\n';
    fs.writeFileSync(configPath(), corrupt);
    setTierParseFailureListener(() => {});

    const res = await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      patch: { cortex: { enabled: true } },
    });
    expect(res.status).toBe(422);
    expect((res.body as Record<string, unknown>).error).toBe('tier_config_unreadable');
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(corrupt);
  });

  it('agent-tasks no-Grove fallback returns 422 on corrupt myco.yaml and leaves it untouched', async () => {
    const corrupt = 'agent: [unterminated\n';
    fs.writeFileSync(configPath(), corrupt);
    setTierParseFailureListener(() => {});

    const req = {
      params: { id: 'vault-evolve' },
      query: {},
      body: { maxTurns: 9 },
    } as unknown as RouteRequest;
    const res = await handleUpdateTaskConfig(req, vaultDir, null);
    expect(res.status).toBe(422);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(corrupt);
  });
});
