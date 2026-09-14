import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withCloudflareOperation } from '@myco/server/cloudflare-operation.js';
import { readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { createCloudflareDeployment, updateCloudflareDeployment, rollbackCloudflareDeployment, destroyCloudflareDeployment } from '@myco/server/cloudflare-lifecycle.js';
import { stageCloudflareDeploy } from '@myco/server/cloudflare-stage.js';

const record = { accountId: 'fixture', workerName: 'fixture', databaseName: 'fixture', bucketName: 'fixture', versionId: null, deployedAt: 'fixture' };

it('holds ownership across asynchronous provisioning and refuses every competing lifecycle or publication path', async () => {
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cloudflare-operation-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = withCloudflareOperation(mycoHome, async () => {
    writeDeploymentRecord(record, mycoHome);
    await gate;
    writeDeploymentRecord({ ...record, fleet: 2 }, mycoHome);
  });
  try {
    expect(() => writeDeploymentRecord({ ...record, fleet: 9 }, mycoHome)).toThrow('in use');
    expect(() => stageCloudflareDeploy(record, mycoHome)).toThrow('in use');
    const runner = { run: async () => { throw new Error('provider must not run'); } };
    for (const command of [createCloudflareDeployment, updateCloudflareDeployment, rollbackCloudflareDeployment, destroyCloudflareDeployment]) {
      await expect(command({ mycoHome, accountId: 'fixture', runner })).rejects.toThrow('in use');
    }
    expect(readDeploymentRecord(mycoHome)).toEqual(record);
    release();
    await held;
    expect(readDeploymentRecord(mycoHome)?.fleet).toBe(2);
    writeDeploymentRecord({ ...record, fleet: 3 }, mycoHome);
    expect(readDeploymentRecord(mycoHome)?.fleet).toBe(3);
  } finally { release(); await held; fs.rmSync(mycoHome, { recursive: true, force: true }); }
});

it('releases failed operations and refuses a symbolic-link lock', async () => {
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cloudflare-operation-'));
  try {
    await expect(withCloudflareOperation(mycoHome, async () => { throw new Error('fixture failure'); })).rejects.toThrow('fixture failure');
    writeDeploymentRecord(record, mycoHome);
    if (process.platform === 'win32') return;
    const lock = path.join(mycoHome, 'server', 'cloudflare.lock');
    fs.rmSync(lock);
    fs.symlinkSync(path.join(mycoHome, 'server', 'cloudflare', 'record.json'), lock);
    expect(() => writeDeploymentRecord(record, mycoHome)).toThrow('regular file');
    expect(readDeploymentRecord(mycoHome)).toEqual(record);
  } finally { fs.rmSync(mycoHome, { recursive: true, force: true }); }
});
