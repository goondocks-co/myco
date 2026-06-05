/**
 * The global multi-tenant daemon's startup anchor carries NO project — it
 * serves every tenant per request. These tests pin the elimination of the
 * phantom `_unbound-bootstrap` project: the anchor context is project-less
 * (projectId null) and no fabricated `proj_<hex>` id is ever derivable from
 * the phantom vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  daemonGlobalRequestContext,
  rowProjectIdFromRequestContext,
  projectScopeFromRequestContext,
  requestContextFromHttpHeaders,
} from '@myco/grove/request-context.js';
import {
  resolveBootstrapVaultDirOrPhantom,
  resolvePhantomBootstrapVaultDir,
} from '@myco/vault/bootstrap.js';

describe('daemon-global anchor context', () => {
  it('carries no project or grove', () => {
    const ctx = daemonGlobalRequestContext('/tmp/_unbound-bootstrap');
    expect(ctx.projectId).toBeNull();
    expect(ctx.groveId).toBeNull();
  });

  it('resolves to NULL row tenancy and GLOBAL_SCOPE (daemon-owned, never the phantom id)', () => {
    const ctx = daemonGlobalRequestContext('/tmp/_unbound-bootstrap');
    expect(rowProjectIdFromRequestContext(ctx)).toBeNull();
    expect(projectScopeFromRequestContext(ctx)).toEqual({ kind: 'global' });
  });

  it('a context-less daemon request against the project-less anchor resolves daemon-global, not throw', () => {
    // A manifest-less vault with no caller headers resolves to the
    // daemon-global context (GLOBAL_SCOPE), not a throw.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-anchor-vault-'));
    try {
      const ctx = requestContextFromHttpHeaders({}, dir);
      expect(ctx.projectId).toBeNull();
      expect(ctx.groveId).toBeNull();
      expect(projectScopeFromRequestContext(ctx)).toEqual({ kind: 'global' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('phantom bootstrap mints no project id', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevVariant: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-phantom-home-'));
    prevHome = process.env.MYCO_HOME;
    prevVariant = process.env.MYCO_SERVICE_VARIANT;
    process.env.MYCO_HOME = tmpHome;
    // A service variant forces the project-less phantom boot path.
    process.env.MYCO_SERVICE_VARIANT = 'service';
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = prevHome;
    if (prevVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
    else process.env.MYCO_SERVICE_VARIANT = prevVariant;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('does not write a project.toml into _unbound-bootstrap', () => {
    const { vaultDir, isPhantom } = resolveBootstrapVaultDirOrPhantom();
    expect(isPhantom).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(false);
  });

  it('removes a stale project.toml a prior daemon build minted (no proj_ survives upgrade)', () => {
    const phantom = resolvePhantomBootstrapVaultDir(tmpHome);
    fs.mkdirSync(phantom, { recursive: true });
    const stale = path.join(phantom, 'project.toml');
    fs.writeFileSync(
      stale,
      '[project]\nid = "proj_deadbeefdeadbeefdeadbeefdeadbeef"\nname = "myco-bootstrap"\n',
    );

    resolveBootstrapVaultDirOrPhantom();

    expect(fs.existsSync(stale)).toBe(false);
  });
});
