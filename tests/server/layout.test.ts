/**
 * Layout migration: each target owns a subtree, and destroying one cannot
 * reach the other. The old single-directory layout is brought forward on
 * first touch, moved never copied, and an occupied destination is never
 * clobbered.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureServerLayout } from '@myco/server/layout.js';
import { deploymentRecordPath, readDeploymentRecord } from '@myco/server/cloudflare.js';
import { resolveDeploymentPaths, removeBundle, bundleContents } from '@myco/server/deployment.js';

const home = () => mkdtempSync(join(tmpdir(), 'myco-layout-'));

function oldLayout(root: string): void {
  const server = join(root, 'server');
  mkdirSync(join(server, 'secrets'), { recursive: true });
  writeFileSync(join(server, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(server, 'secrets', 'session_secret'), 's3cret\n');
  writeFileSync(join(server, '.env'), 'MYCO_PORT=8787\n');
  writeFileSync(join(server, 'cloudflare.json'), JSON.stringify({ accountId: 'a', workerName: 'w', databaseName: 'd', bucketName: 'b', versionId: null, deployedAt: 'now' }));
}

describe('server layout migration', () => {
  it('moves the old single-directory layout into per-target subtrees', () => {
    const h = home();
    oldLayout(h);
    ensureServerLayout(h);
    expect(existsSync(join(h, 'server', 'compose', 'compose.yaml'))).toBe(true);
    expect(readFileSync(join(h, 'server', 'compose', 'secrets', 'session_secret'), 'utf8')).toBe('s3cret\n');
    expect(existsSync(join(h, 'server', 'cloudflare', 'record.json'))).toBe(true);
    expect(existsSync(join(h, 'server', 'compose.yaml'))).toBe(false);
    expect(existsSync(join(h, 'server', 'cloudflare.json'))).toBe(false);
  });

  it('runs from both path resolvers, is idempotent, and a fresh home is untouched', () => {
    const h = home();
    oldLayout(h);
    expect(readDeploymentRecord(h)?.workerName).toBe('w');
    expect(resolveDeploymentPaths(h).composeFile).toBe(join(h, 'server', 'compose', 'compose.yaml'));
    expect(existsSync(resolveDeploymentPaths(h).composeFile)).toBe(true);
    ensureServerLayout(h);
    const fresh = home();
    ensureServerLayout(fresh);
    expect(existsSync(join(fresh, 'server'))).toBe(false);
  });

  it('brings a partial layout forward name by name', () => {
    const h = home();
    mkdirSync(join(h, 'server'), { recursive: true });
    writeFileSync(join(h, 'server', '.env'), 'MYCO_PORT=1\n', { mode: 0o600 });
    ensureServerLayout(h);
    expect(existsSync(join(h, 'server', 'compose', '.env'))).toBe(true);
    expect(existsSync(join(h, 'server', 'compose', 'compose.yaml'))).toBe(false);
  });

  it('never clobbers an occupied destination', () => {
    const h = home();
    oldLayout(h);
    mkdirSync(join(h, 'server', 'cloudflare'), { recursive: true });
    writeFileSync(join(h, 'server', 'cloudflare', 'record.json'), '{"workerName":"kept"}');
    ensureServerLayout(h);
    expect(JSON.parse(readFileSync(join(h, 'server', 'cloudflare', 'record.json'), 'utf8')).workerName).toBe('kept');
    expect(existsSync(join(h, 'server', 'cloudflare.json'))).toBe(true);
  });

  it('GATE: removing the Compose bundle leaves the Cloudflare record standing', () => {
    const h = home();
    oldLayout(h);
    const paths = resolveDeploymentPaths(h);
    removeBundle(paths);
    expect(existsSync(paths.composeFile)).toBe(false);
    expect(readDeploymentRecord(h)?.workerName).toBe('w');
    expect(bundleContents(paths)).toEqual([]);
  });
});
