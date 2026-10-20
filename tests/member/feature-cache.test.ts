/**
 * The Deployment feature snapshot is published before its answer order is written, and the order is recovered from
 * the snapshot: a snapshot that failed to publish never advances the order, and one published before a crash still
 * orders the answers after it.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginFeatureRequest, cacheDeploymentFeatures, readDeploymentFeaturesStrict } from '@myco/member/context-cache.js';
import { deploymentFeaturesPath } from '@myco/member/registry.js';
import * as store from '@myco/member/store.js';

const SERVER_URL = 'https://features.example';
const scratches: string[] = [];
afterEach(() => { for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function home(): string {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-feature-cache-'));
  scratches.push(run);
  return path.join(run, 'myco');
}

describe('Deployment feature cache order', () => {
  it('accepts an older answer when a newer one failed to publish its snapshot', () => {
    const mycoHome = home();
    const first = beginFeatureRequest(SERVER_URL, mycoHome);
    const second = beginFeatureRequest(SERVER_URL, mycoHome);
    const file = deploymentFeaturesPath(SERVER_URL, mycoHome);
    fs.mkdirSync(file);
    expect(() => cacheDeploymentFeatures(SERVER_URL, ['turn'], mycoHome, second)).toThrow();
    fs.rmdirSync(file);
    expect(cacheDeploymentFeatures(SERVER_URL, ['turn'], mycoHome, first)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ features: ['turn'], receivedAt: first });
    expect(JSON.parse(fs.readFileSync(`${file}.order`, 'utf8'))).toMatchObject({ receivedAt: first, issued: second });
  });

  it('refuses an older answer after a newer one with unchanged features failed to write its order', () => {
    const mycoHome = home();
    expect(cacheDeploymentFeatures(SERVER_URL, ['turn'], mycoHome)).toBe(true);
    const older = beginFeatureRequest(SERVER_URL, mycoHome);
    const newer = beginFeatureRequest(SERVER_URL, mycoHome);
    const orderFile = `${deploymentFeaturesPath(SERVER_URL, mycoHome)}.order`;
    const write = store.writePrivateFileAtomic;
    const fail = spyOn(store, 'writePrivateFileAtomic').mockImplementation((file, body) => {
      if (file === orderFile) throw new Error('ordering state unavailable');
      write(file, body);
    });
    try { expect(() => cacheDeploymentFeatures(SERVER_URL, ['turn'], mycoHome, newer)).toThrow('ordering state unavailable'); }
    finally { fail.mockRestore(); }
    expect(cacheDeploymentFeatures(SERVER_URL, [], mycoHome, older)).toBe(false);
    expect(readDeploymentFeaturesStrict({ serverUrl: SERVER_URL, projectId: '' }, mycoHome)).toEqual(['turn']);
  });

  it('refuses an older answer after a crash between publishing the snapshot and writing its order', () => {
    const mycoHome = home();
    const first = beginFeatureRequest(SERVER_URL, mycoHome);
    const second = beginFeatureRequest(SERVER_URL, mycoHome);
    const file = deploymentFeaturesPath(SERVER_URL, mycoHome);
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, features: ['turn'], receivedAt: second })}\n`, { mode: 0o600 });
    expect(cacheDeploymentFeatures(SERVER_URL, [], mycoHome, first)).toBe(false);
    expect(readDeploymentFeaturesStrict({ serverUrl: SERVER_URL, projectId: '' }, mycoHome)).toEqual(['turn']);
    expect(beginFeatureRequest(SERVER_URL, mycoHome)).toBe(second + 1);
  });
});
