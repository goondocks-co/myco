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
  resolveSentinelPath,
  hasGlobalInstallMigrationCompleted,
  readMigrationSentinel,
} from '@myco/grove/global-install-migration.js';
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
});
