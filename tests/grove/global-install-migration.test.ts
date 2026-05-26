/**
 * Tests for the one-shot global-install migration.
 *
 * Plan reference: `38cff0752c919ffd` §5 — migrateProjectToGlobalInstall
 * runs ONCE per project, sentinel-gated, archives forensic state before
 * stripping Myco markers from co-tenant config files, propagates the
 * legacy machine_id into the global cache, and prunes empty artifacts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  migrateProjectToGlobalInstall,
  propagateLegacyMachineIdAtStartup,
  resolveSentinelPath,
  hasGlobalInstallMigrationCompleted,
  readMigrationSentinel,
} from '@myco/grove/global-install-migration.js';

// Fixture helper: seed a Grove on disk with a registered project that
// has a legacy machine_id in its vault. Matches the on-disk shape
// listGroves + listRegisteredProjects read from.
function seedGroveWithLegacyProject(
  mycoHome: string,
  opts: { groveId: string; projectId: string; projectRoot: string; servedBy: string; machineId: string },
): void {
  const groveDir = path.join(mycoHome, 'groves', opts.groveId);
  fs.mkdirSync(path.join(groveDir, 'registry'), { recursive: true });
  fs.writeFileSync(
    path.join(groveDir, 'grove.toml'),
    `[grove]\nid = "${opts.groveId}"\nname = "Test"\nslug = "test"\nmode = "local"\ncreated_at = "2026-05-26T00:00:00.000Z"\nserved_by = "${opts.servedBy}"\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(groveDir, 'registry/projects.toml'),
    `[projects.${opts.projectId}]\nproject_id = "${opts.projectId}"\nname = "test-project"\nroot = "${opts.projectRoot}"\nbinding_id = "gbind_${opts.projectId.slice(5, 13)}"\ncreated_at = "2026-05-26T00:00:00.000Z"\nupdated_at = "2026-05-26T00:00:00.000Z"\n`,
    'utf-8',
  );
  fs.mkdirSync(path.join(opts.projectRoot, '.myco'), { recursive: true });
  fs.writeFileSync(path.join(opts.projectRoot, '.myco/machine_id'), opts.machineId, 'utf-8');
}
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

function makeFakeManifest(overrides: Partial<SymbiontManifest> = {}): SymbiontManifest {
  return {
    name: 'claude-code',
    displayName: 'Claude Code',
    binary: 'claude',
    configDir: '.claude',
    pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
    hookFields: {
      sessionId: 'session_id',
      transcriptPath: 'transcript_path',
      lastResponse: 'last_response',
      prompt: 'prompt',
      toolName: 'tool_name',
      toolInput: 'tool_input',
      toolOutput: 'tool_output',
    },
    registration: {
      hooksTarget: '.claude/settings.json',
      hooksFormat: 'json',
      mcpFormat: 'json',
      mcpServersKey: 'mcpServers',
      settingsFormat: 'json',
    },
    ...overrides,
  } as SymbiontManifest;
}

describe('migrateProjectToGlobalInstall', () => {
  let projectRoot: string;
  let mycoHome: string;
  let priorMycoHome: string | undefined;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mig-project-'));
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mig-home-'));
    priorMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = priorMycoHome;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('writes the sentinel on a clean project with no legacy artifacts', () => {
    const result = migrateProjectToGlobalInstall(projectRoot, { manifests: [], packageRoot: '/tmp' });
    expect(result.alreadyDone).toBe(false);
    expect(result.noLegacyArtifacts).toBe(true);
    expect(result.archivedFiles).toEqual([]);
    expect(result.archiveDir).toBeNull();
    expect(hasGlobalInstallMigrationCompleted(projectRoot)).toBe(true);
    const sentinel = readMigrationSentinel(projectRoot);
    expect(sentinel?.schema_version).toBe(1);
    expect(sentinel?.archived_to).toBeNull();
    expect(typeof sentinel?.pass_id).toBe('string');
    expect(typeof sentinel?.migrated_at).toBe('number');
  });

  it('is idempotent — second call returns alreadyDone with no side effects', () => {
    const first = migrateProjectToGlobalInstall(projectRoot, { manifests: [], packageRoot: '/tmp' });
    const sentinelMtime = fs.statSync(resolveSentinelPath(projectRoot)).mtimeMs;

    const second = migrateProjectToGlobalInstall(projectRoot, { manifests: [], packageRoot: '/tmp' });
    expect(second.alreadyDone).toBe(true);
    expect(second.passId).not.toBe(first.passId);  // new id is generated but not used
    // Sentinel on disk is unchanged.
    expect(fs.statSync(resolveSentinelPath(projectRoot)).mtimeMs).toBe(sentinelMtime);
  });

  it('archives manifest-declared config files when they exist on disk', () => {
    // Seed a project-level Myco hook config.
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.claude/settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'node /Users/x/.myco/launcher.cjs hook session-start --symbiont claude-code' }] }] } }),
      'utf-8',
    );

    const manifest = makeFakeManifest();
    const result = migrateProjectToGlobalInstall(projectRoot, { manifests: [manifest], packageRoot: '/tmp' });

    expect(result.archivedFiles.length).toBeGreaterThan(0);
    expect(result.archiveDir).toContain('.archive-pre-global-install-');
    // Archive directory is inside the vault, sentinel records the relative path.
    expect(result.sentinel?.archived_to).toMatch(/^\.archive-pre-global-install-/);
    // Archived snapshot still exists at the archive path.
    const archivedFile = path.join(result.archiveDir!, '.claude/settings.json');
    expect(fs.existsSync(archivedFile)).toBe(true);
  });

  it('propagates a project-scope machine_id into ~/.myco/machine_id when global is absent', () => {
    fs.writeFileSync(path.join(projectRoot, '.myco/machine_id'), 'legacy_machine_aaaa1111', 'utf-8');

    const result = migrateProjectToGlobalInstall(projectRoot, { manifests: [], packageRoot: '/tmp' });
    expect(result.machineIdPropagated).toBe(true);
    const global = fs.readFileSync(path.join(mycoHome, 'machine_id'), 'utf-8').trim();
    expect(global).toBe('legacy_machine_aaaa1111');
  });

  it('does not overwrite an existing global machine_id', () => {
    fs.writeFileSync(path.join(mycoHome, 'machine_id'), 'global_pre_existing', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.myco/machine_id'), 'legacy_machine_bbbb2222', 'utf-8');

    const result = migrateProjectToGlobalInstall(projectRoot, { manifests: [], packageRoot: '/tmp' });
    expect(result.machineIdPropagated).toBe(false);
    const global = fs.readFileSync(path.join(mycoHome, 'machine_id'), 'utf-8').trim();
    expect(global).toBe('global_pre_existing');
  });

  it('skips archive step for manifests whose registration targets are absent on disk', () => {
    const result = migrateProjectToGlobalInstall(projectRoot, {
      manifests: [makeFakeManifest()],
      packageRoot: '/tmp',
    });
    expect(result.archivedFiles).toEqual([]);
    expect(result.archiveDir).toBeNull();
  });

  it('purges legacy per-machine artifacts from the project vault', () => {
    // Seed the kinds of files a pre-global-install vault accumulates.
    fs.writeFileSync(path.join(projectRoot, '.myco/last-update-version'), '0.21.0', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.myco/restart-reason.json'), '{"reason":"x"}', 'utf-8');
    fs.mkdirSync(path.join(projectRoot, '.myco/attachments'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.myco/attachments/dummy.png'), 'fake', 'utf-8');
    fs.mkdirSync(path.join(projectRoot, '.myco/team'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.myco/installer-audit'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.myco/installer-audit/x.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.myco/secrets.env'), 'API_KEY=oldvalue', 'utf-8');

    migrateProjectToGlobalInstall(projectRoot, { manifests: [], packageRoot: '/tmp' });

    expect(fs.existsSync(path.join(projectRoot, '.myco/last-update-version'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/restart-reason.json'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/attachments'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/team'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/installer-audit'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/secrets.env'))).toBe(false);
    // Sentinel still written on a "noLegacyArtifacts: false" pass.
    expect(hasGlobalInstallMigrationCompleted(projectRoot)).toBe(true);
  });

  // Regression for code-review finding C4: user-data artifacts must be
  // ARCHIVED (moved into .archive-pre-global-install-<ts>/) before purge,
  // not destroyed. team/, attachments/, installer-audit/ carry user
  // data with no in-tree migration target.
  it('archives user-data artifacts (team/, attachments/, installer-audit/) before purging', () => {
    fs.mkdirSync(path.join(projectRoot, '.myco/team/worker'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.myco/team/worker/build.txt'), 'legacy-team-build', 'utf-8');
    fs.mkdirSync(path.join(projectRoot, '.myco/attachments'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.myco/attachments/img.png'), 'legacy-png', 'utf-8');
    fs.mkdirSync(path.join(projectRoot, '.myco/installer-audit'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.myco/installer-audit/strip.json'), '{"k":"v"}', 'utf-8');
    // Ephemera + propagated artifacts that should NOT appear in the archive.
    fs.writeFileSync(path.join(projectRoot, '.myco/machine_id'), 'legacy_id', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.myco/secrets.env'), 'API_KEY=hush', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.myco/restart-reason.json'), '{"r":"x"}', 'utf-8');

    const result = migrateProjectToGlobalInstall(projectRoot, { manifests: [], packageRoot: '/tmp' });

    expect(fs.existsSync(path.join(projectRoot, '.myco/team'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/attachments'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/installer-audit'))).toBe(false);

    expect(result.archiveDir).not.toBeNull();
    const archiveDir = result.archiveDir!;
    expect(fs.existsSync(archiveDir)).toBe(true);

    expect(fs.readFileSync(path.join(archiveDir, 'team/worker/build.txt'), 'utf-8')).toBe('legacy-team-build');
    expect(fs.readFileSync(path.join(archiveDir, 'attachments/img.png'), 'utf-8')).toBe('legacy-png');
    expect(fs.readFileSync(path.join(archiveDir, 'installer-audit/strip.json'), 'utf-8')).toBe('{"k":"v"}');

    expect(fs.existsSync(path.join(archiveDir, 'secrets.env'))).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, 'machine_id'))).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, 'restart-reason.json'))).toBe(false);
  });

  // Regression for code-review finding C10: the retired walker used to
  // reconcile project .gitignore for skills + plan dirs on every tick.
  // migrateProjectToGlobalInstall must do the same once-per-project so
  // the first hook event on a legacy project produces a healthy
  // .gitignore, without waiting for the next `myco update` cycle.
  it('reconciles project .gitignore for skill + wrangler entries', () => {
    // Seed an empty .gitignore so the reconcile writes its block.
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '', 'utf-8');
    // Seed a bundled-skill source so listSkillDirs has something to find.
    const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mig-pkgroot-'));
    fs.mkdirSync(path.join(pkgRoot, 'skills/sample-skill'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'skills/sample-skill/SKILL.md'), '# sample', 'utf-8');

    // skillsTarget is required by updateGitignore's early-exit gate.
    const manifestWithSkills = makeFakeManifest({
      registration: {
        hooksTarget: '.claude/settings.json',
        hooksFormat: 'json',
        mcpFormat: 'json',
        mcpServersKey: 'mcpServers',
        settingsFormat: 'json',
        skillsTarget: '.agents/skills',
      },
    });

    migrateProjectToGlobalInstall(projectRoot, {
      manifests: [manifestWithSkills],
      packageRoot: pkgRoot,
    });

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('sample-skill');

    fs.rmSync(pkgRoot, { recursive: true, force: true });
  });
});

// Regression for code-review finding C2: daemon startup must propagate
// any registered project's legacy machine_id into the global cache
// BEFORE getMachineId() mints a fresh value, or historic capture rows
// get orphaned from the live identity.
describe('propagateLegacyMachineIdAtStartup', () => {
  let projectRoot: string;
  let mycoHome: string;
  let priorMycoHome: string | undefined;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-startup-project-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-startup-home-'));
    priorMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = priorMycoHome;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('lifts a registered project\'s legacy machine_id into ~/.myco/machine_id', () => {
    seedGroveWithLegacyProject(mycoHome, {
      groveId: 'grove_11111111111111111111111111111111',
      projectId: 'proj_11111111111111111111111111111111',
      projectRoot,
      servedBy: 'service',
      machineId: 'legacy_startup_id_alpha',
    });
    // No global machine_id yet — simulates the racey daemon-startup window.
    expect(fs.existsSync(path.join(mycoHome, 'machine_id'))).toBe(false);

    const sourceRoot = propagateLegacyMachineIdAtStartup({ mycoHome, servedBy: 'service' });

    expect(sourceRoot).toBe(projectRoot);
    expect(fs.readFileSync(path.join(mycoHome, 'machine_id'), 'utf-8').trim())
      .toBe('legacy_startup_id_alpha');
  });

  it('no-ops when ~/.myco/machine_id already exists', () => {
    fs.writeFileSync(path.join(mycoHome, 'machine_id'), 'global_pre_existing', 'utf-8');
    seedGroveWithLegacyProject(mycoHome, {
      groveId: 'grove_22222222222222222222222222222222',
      projectId: 'proj_22222222222222222222222222222222',
      projectRoot,
      servedBy: 'service',
      machineId: 'should_not_overwrite',
    });

    const sourceRoot = propagateLegacyMachineIdAtStartup({ mycoHome, servedBy: 'service' });

    expect(sourceRoot).toBeNull();
    expect(fs.readFileSync(path.join(mycoHome, 'machine_id'), 'utf-8').trim())
      .toBe('global_pre_existing');
  });

  it('skips Groves not served by this daemon variant', () => {
    seedGroveWithLegacyProject(mycoHome, {
      groveId: 'grove_33333333333333333333333333333333',
      projectId: 'proj_33333333333333333333333333333333',
      projectRoot,
      servedBy: 'service-dev',  // dev-served grove
      machineId: 'dev_only_id',
    });

    // Prod daemon scans only service-served groves.
    const sourceRoot = propagateLegacyMachineIdAtStartup({ mycoHome, servedBy: 'service' });

    expect(sourceRoot).toBeNull();
    expect(fs.existsSync(path.join(mycoHome, 'machine_id'))).toBe(false);
  });

  it('returns null on a greenfield daemon with no registered Groves', () => {
    const sourceRoot = propagateLegacyMachineIdAtStartup({ mycoHome, servedBy: 'service' });
    expect(sourceRoot).toBeNull();
    expect(fs.existsSync(path.join(mycoHome, 'machine_id'))).toBe(false);
  });
});
