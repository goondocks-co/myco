/**
 * The Deployment a machine runs itself: its directory, its settings, and the
 * options a start reads from them.
 *
 * `tests/myco-server/selfhosted/binary-target.test.ts` proves the server serves
 * what these options describe. This proves the settings that reach it are
 * settings that can serve — a record that would establish no caller identity is
 * refused where it is written, rather than at the first request.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_LOCAL_RECORD,
  LocalDeploymentAbsent,
  LocalRecordUnreadable,
  assertRecordServable,
  ensureLocalSecrets,
  localDeploymentPresent,
  readLocalRecord,
  readLocalSecrets,
  removeLocalDeployment,
  resolveLocalPaths,
  writeLocalRecord,
} from '@myco/server/local.js';
import { optionsFromRecord } from '@myco/server/local-run.js';

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

const home = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'myco-local-home-'));
  homes.push(root);
  return root;
};

describe('the Deployment directory', () => {
  it('lives beside the other targets rather than over them', () => {
    const root = home();
    const paths = resolveLocalPaths(root);
    expect(paths.root).toBe(join(root, 'server', 'local'));
    expect(paths.databasePath).toBe(join(root, 'server', 'local', 'myco.sqlite'));
  });

  it('reports no Deployment before one is written, and names the verb that makes one', () => {
    const paths = resolveLocalPaths(home());
    expect(localDeploymentPresent(paths)).toBe(false);
    expect(() => readLocalRecord(paths)).toThrow(LocalDeploymentAbsent);
    expect(() => readLocalRecord(paths)).toThrow(/myco server create/);
  });

  it('keeps the settings and the secrets readable only by their owner', () => {
    const paths = resolveLocalPaths(home());
    writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);
    ensureLocalSecrets(paths);
    for (const file of [paths.recordFile, paths.secretsFile]) {
      expect({ file, mode: statSync(file).mode & 0o777 }).toEqual({ file, mode: 0o600 });
    }
  });

  it('generates what it seals its own store under, once, and keeps it across a second create', () => {
    const paths = resolveLocalPaths(home());
    writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);

    expect(ensureLocalSecrets(paths).sort()).toEqual(['SECRET_WRAP_KEY', 'SESSION_SECRET']);
    const first = readLocalSecrets(paths);
    expect(first.SECRET_WRAP_KEY!.length).toBeGreaterThan(0);

    // A regenerated wrapping key makes every credential the Deployment already
    // holds undecryptable, so a second create must leave it alone.
    expect(ensureLocalSecrets(paths)).toEqual([]);
    expect(readLocalSecrets(paths)).toEqual(first);
  });

  it('refuses settings it cannot read rather than serving a default Deployment', () => {
    const paths = resolveLocalPaths(home());
    writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);
    writeFileSync(paths.recordFile, 'not json');
    expect(() => readLocalRecord(paths)).toThrow(LocalRecordUnreadable);
  });

  it('removes the directory and everything in it', () => {
    const paths = resolveLocalPaths(home());
    writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);
    ensureLocalSecrets(paths);
    removeLocalDeployment(paths);
    expect(localDeploymentPresent(paths)).toBe(false);
  });
});

describe('settings a start can serve', () => {
  it('refuses a proxy source that establishes no identity', () => {
    expect(() => assertRecordServable({ ...DEFAULT_LOCAL_RECORD, sourceFrom: 'proxy' }))
      .toThrow(/trustedHeader/);
    expect(() => assertRecordServable({ ...DEFAULT_LOCAL_RECORD, sourceFrom: 'proxy', trustedHeader: 'x-forwarded-for', trustedHops: 0 }))
      .toThrow(/trustedHops/);
    expect(() => assertRecordServable({ ...DEFAULT_LOCAL_RECORD, sourceFrom: 'proxy', trustedHeader: 'x-forwarded-for' }))
      .not.toThrow();
  });

  it('refuses a port and a fleet that are not whole numbers of the thing they count', () => {
    expect(() => assertRecordServable({ ...DEFAULT_LOCAL_RECORD, port: 70_000 })).toThrow(/port/);
    expect(() => assertRecordServable({ ...DEFAULT_LOCAL_RECORD, fleet: 0 })).toThrow(/fleet/);
  });

  it('takes the caller address from the socket by default, which no caller can forge', () => {
    const paths = resolveLocalPaths(home());
    const options = optionsFromRecord(DEFAULT_LOCAL_RECORD, paths);
    expect({ sourceFrom: options.sourceFrom, bind: options.bind, transport: options.transport })
      .toEqual({ sourceFrom: 'socket', bind: 'loopback', transport: 'loopback' });
  });

  it('names its own loopback as the origin runs call back to, until something fronts it', () => {
    const paths = resolveLocalPaths(home());
    expect(optionsFromRecord({ ...DEFAULT_LOCAL_RECORD, port: 9123 }, paths).origin)
      .toBe('http://127.0.0.1:9123');
    expect(optionsFromRecord({ ...DEFAULT_LOCAL_RECORD, origin: 'https://myco.example' }, paths).origin)
      .toBe('https://myco.example');
  });

  it('carries its dashboard and its native artifacts rather than locating them on the host', () => {
    const paths = resolveLocalPaths(home());
    const options = optionsFromRecord(DEFAULT_LOCAL_RECORD, paths);
    expect(Object.keys(options.uiAssets!)).toContain('index.html');
    expect(options.native!.vec0).toMatch(/vec0\.(dylib|so|dll)$/);
  });

  it('hands the stored secrets to the start rather than leaving it to fail on the first credential', () => {
    const paths = resolveLocalPaths(home());
    writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);
    ensureLocalSecrets(paths);
    const options = optionsFromRecord(DEFAULT_LOCAL_RECORD, paths, readLocalSecrets(paths));
    expect(options.SECRET_WRAP_KEY!.length).toBeGreaterThan(0);
    expect(options.SESSION_SECRET!.length).toBeGreaterThan(0);
  });
});
