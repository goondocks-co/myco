/**
 * SymbiontInstaller scope-aware behavior (Step 4).
 *
 * Covers the operations that diverge between `'project'` and `'global'`
 * scope: project-content surfaces are skipped under `'global'`, target
 * paths come from `globalXxxTarget`, the global hook-guard step cleans up
 * any retired `~/.myco/launcher.cjs` + `mcp-launcher.cjs` trampolines (the
 * binary is the launcher now), and a detection gate refuses installs when
 * the agent's `detectionDir` is absent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { claimSubsystem, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/grove/subsystem-claim.js';
import { daemonIdentity } from '@myco/grove/paths.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

describe('SymbiontInstaller installScope=global', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevMycoHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-scope-'));
    prevHome = process.env.HOME;
    prevMycoHome = process.env.MYCO_HOME;
    process.env.HOME = tmpHome;
    process.env.MYCO_HOME = path.join(tmpHome, '.myco');
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
  });

  function getManifest(name: string) {
    const m = loadManifests().find((x) => x.name === name);
    if (!m) throw new Error(`Manifest not found: ${name}`);
    return m;
  }

  it('refuses to install when the agent detectionDir is absent', () => {
    // tmpHome has no `.claude/` dir — claude-code's detectionDir should miss.
    const installer = new SymbiontInstaller(
      getManifest('claude-code'),
      tmpHome,
      PKG_ROOT,
      false,
      undefined,
      null,
      'global',
    );
    expect(installer.isAvailableForScope()).toBe(false);
    const result = installer.install();
    expect(result).toEqual({
      hooks: false, mcp: false, skills: false, settings: false,
      instructions: false, pluginPackage: false, pluginManifest: false,
    });
    // No `~/.claude/` created on behalf of the agent.
    expect(fs.existsSync(path.join(tmpHome, '.claude'))).toBe(false);
  });

  it('defers a global install (writes nothing) when a peer owns the symbiont-config claim', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });

    // A peer home owns the claim, shared via MYCO_CLAIMS_HOME. This daemon's
    // identity is MYCO_HOME (tmpHome/.myco), so it must defer.
    const claimsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-claims-'));
    const peer = daemonIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-peer-')));
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, peer, { claimsHome });
    const prevClaims = process.env.MYCO_CLAIMS_HOME;
    process.env.MYCO_CLAIMS_HOME = claimsHome;
    try {
      const installer = new SymbiontInstaller(
        getManifest('claude-code'), tmpHome, PKG_ROOT, false, undefined, null, 'global',
      );
      const result = installer.install();
      expect(result).toEqual({
        hooks: false, mcp: false, skills: false, settings: false,
        instructions: false, pluginPackage: false, pluginManifest: false,
      });
      // The deferred install wrote nothing into the agent's global config.
      expect(fs.existsSync(path.join(tmpHome, '.claude', 'settings.json'))).toBe(false);
    } finally {
      if (prevClaims === undefined) delete process.env.MYCO_CLAIMS_HOME; else process.env.MYCO_CLAIMS_HOME = prevClaims;
      fs.rmSync(claimsHome, { recursive: true, force: true });
    }
  });

  it('installs claude-code into ~/.claude/settings.json when detectionDir exists', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });

    const installer = new SymbiontInstaller(
      getManifest('claude-code'),
      tmpHome,
      PKG_ROOT,
      false,
      undefined,
      null,
      'global',
    );
    expect(installer.isAvailableForScope()).toBe(true);
    installer.install();

    // Hooks + MCP land in ~/.claude/settings.json (the same file under
    // global scope — settings-merge handles the marker-bounded block).
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.mcpServers?.myco).toBeDefined();

    // No launcher trampolines are written — the binary is the launcher
    // now; the hook command invokes it directly.
    expect(fs.existsSync(path.join(tmpHome, '.myco', 'launcher.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.myco', 'mcp-launcher.cjs'))).toBe(false);

    // Project-content surfaces are NOT created under global scope.
    expect(fs.existsSync(path.join(tmpHome, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.gitignore'))).toBe(false);
    // .agents/myco-run.cjs is the project-scope hook guard — should not
    // exist under global scope (the launchers above take its place).
    expect(fs.existsSync(path.join(tmpHome, '.agents', 'myco-run.cjs'))).toBe(false);
  });

  it('global install does NOT delete retired launchers — removal is deferred until after all configs are rewritten', () => {
    // Capture-safety ordering (P1a): `~/.myco/launcher.cjs` is shared across every
    // symbiont, so deleting it during ONE symbiont's install would orphan the
    // still-old configs of every symbiont not yet rewritten in the same pass —
    // a window where their `node …/launcher.cjs` hooks hit ENOENT and capture
    // goes dark. install() therefore leaves the trampolines in place; the
    // orchestrating flows (runGlobalBootstrap / `myco update` / the hourly
    // detection tick) call removeRetiredGlobalLaunchers() ONCE, after every
    // detected agent's config has been rewritten onto the binary.
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    const mycoHome = path.join(tmpHome, '.myco');
    fs.mkdirSync(mycoHome, { recursive: true });
    const launcherPath = path.join(mycoHome, 'launcher.cjs');
    const mcpLauncherPath = path.join(mycoHome, 'mcp-launcher.cjs');
    fs.writeFileSync(launcherPath, '// stale launcher\n', 'utf-8');
    fs.writeFileSync(mcpLauncherPath, '// stale mcp launcher\n', 'utf-8');

    const installer = new SymbiontInstaller(
      getManifest('claude-code'),
      tmpHome,
      PKG_ROOT,
      false,
      undefined,
      null,
      'global',
    );
    installer.install();

    // Still present after a single symbiont's install — removal is deferred.
    expect(fs.existsSync(launcherPath)).toBe(true);
    expect(fs.existsSync(mcpLauncherPath)).toBe(true);
  });

  it('project scope is unchanged — AGENTS.md + .gitignore + hook guard land under projectRoot', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-scope-proj-'));
    try {
      fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      const installer = new SymbiontInstaller(
        getManifest('claude-code'),
        projectRoot,
        PKG_ROOT,
        false,
        undefined,
        null,
        'project',
      );
      installer.install();

      expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.gitignore'))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.agents', 'myco-run.cjs'))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.agents', 'myco-cli.cjs'))).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('defers a global uninstall (strips nothing) when a peer owns the symbiont-config claim', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');

    // Install with NO peer claim first so the Myco-managed block exists.
    new SymbiontInstaller(
      getManifest('claude-code'), tmpHome, PKG_ROOT, false, undefined, null, 'global',
    ).install();
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).mcpServers?.myco).toBeDefined();

    // Now a peer owns the claim → a global uninstall must defer, not strip.
    const claimsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-uninstall-claims-'));
    const peer = daemonIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-uninstall-peer-')));
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, peer, { claimsHome });
    const prevClaims = process.env.MYCO_CLAIMS_HOME;
    process.env.MYCO_CLAIMS_HOME = claimsHome;
    try {
      const result = new SymbiontInstaller(
        getManifest('claude-code'), tmpHome, PKG_ROOT, false, undefined, null, 'global',
      ).uninstall();
      expect(result).toEqual({
        hooks: false, mcp: false, skills: false, settings: false,
        instructions: false, pluginPackage: false, pluginManifest: false,
      });
      // The managed block survived — the deferred uninstall stripped nothing.
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).mcpServers?.myco).toBeDefined();
    } finally {
      if (prevClaims === undefined) delete process.env.MYCO_CLAIMS_HOME; else process.env.MYCO_CLAIMS_HOME = prevClaims;
      fs.rmSync(claimsHome, { recursive: true, force: true });
    }
  });

  it('project scope still writes under a peer claim — the gate is global-only', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-proj-claim-'));
    const claimsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-proj-claims-'));
    const peer = daemonIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-proj-peer-')));
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, peer, { claimsHome });
    const prevClaims = process.env.MYCO_CLAIMS_HOME;
    process.env.MYCO_CLAIMS_HOME = claimsHome;
    try {
      fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      new SymbiontInstaller(
        getManifest('claude-code'), projectRoot, PKG_ROOT, false, undefined, null, 'project',
      ).install();
      // installScope === 'global' is false → project writes proceed despite the claim.
      expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(true);
    } finally {
      if (prevClaims === undefined) delete process.env.MYCO_CLAIMS_HOME; else process.env.MYCO_CLAIMS_HOME = prevClaims;
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(claimsHome, { recursive: true, force: true });
    }
  });
});
