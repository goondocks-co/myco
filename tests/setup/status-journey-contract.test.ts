import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderSetupStatus } from '@myco/cli/setup-status.js';
import { observeSetupStatus } from '@myco/setup/observe.js';
import { observeStatusContract } from './fixtures/status-journey-contract.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { writeDeploymentMembership, deploymentPath } from '@myco/member/registry.js';
import { newRunnerBearer, runnerRecordPath } from '@myco/runner/runner-registry.js';
import { writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, peekLocalPaths } from '@myco/server/local.js';
import { statusHome, STATUS_URL, STATUS_NOW } from './fixtures/status-home.js';
import type { SetupAnswers } from '@myco/setup/answers.js';

let scratch: string;
let fixture: ReturnType<typeof statusHome>;
beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-review-equiv-')); fixture = statusHome(scratch); });
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });
const deps = () => ({
  now: () => STATUS_NOW, agents: () => ['claude-code'],
  fetch: Object.assign(async () => { throw new Error('status must not call the network'); }, { preconnect: () => {} }),
  worker: { runner: () => { throw new Error('status must not query services'); } },
  local: { native: { library: null, vec0: null }, service: { runner: () => { throw new Error('fixture service unavailable'); } } },
});
const SECOND = 'https://second.example';
const member = (url: string) => writeDeploymentMembership({ serverUrl: url, token: 'T'.repeat(43), machineId: 'm', joinedAt: 1, updatedAt: 1 }, { mycoHome: fixture.home });
const runner = (url: string) => {
  const record = runnerRecordPath(url, fixture.home);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ version: 1, serverUrl: url, name: 'R', token: newRunnerBearer(), runnerId: 'rn_x', deploymentId: 'd' }), { mode: 0o600 });
};
const local = () => createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, peekLocalPaths(fixture.home));
const cloudflare = (url?: string) => writeDeploymentRecord({ accountId: 'a'.repeat(32), workerName: 'w', databaseName: 'd', bucketName: 'b', versionId: null, deployedAt: new Date(0).toISOString(), ...(url ? { url } : {}) }, fixture.home);

const setups: Record<string, () => void> = {
  base: () => {},
  member: () => member(STATUS_URL),
  twoMembersDefault: () => { member(STATUS_URL); member(SECOND); recordDefaultDeployment(SECOND, { mycoHome: fixture.home }); },
  memberRunner: () => { member(STATUS_URL); runner(SECOND); },
  sameUrlMemberRunner: () => { member(STATUS_URL); runner(STATUS_URL); },
  sameUrlMemberRunnerDefault: () => { member(STATUS_URL); runner(STATUS_URL); recordDefaultDeployment(STATUS_URL, { mycoHome: fixture.home }); },
  localWithOrigin: () => { createLocalDeployment({ ...DEFAULT_LOCAL_RECORD, origin: 'https://fronted.example' }, { library: null, vec0: null }, peekLocalPaths(fixture.home)); member(SECOND); },
  localPlusMember: () => { local(); member(SECOND); },
  cloudflarePlusMember: () => { cloudflare('https://cf.example'); member(STATUS_URL); },
  cloudflareNoUrl: () => { cloudflare(); },
  damagedLocalRecord: () => { member(STATUS_URL); local(); fs.writeFileSync(peekLocalPaths(fixture.home).recordFile, '{'); },
  damagedRunnerRecord: () => { member(STATUS_URL); runner(SECOND); fs.writeFileSync(runnerRecordPath(SECOND, fixture.home), '{', { mode: 0o600 }); },
  damagedMembership: () => { member(STATUS_URL); member(SECOND); fs.writeFileSync(deploymentPath(SECOND, fixture.home), '{', { mode: 0o600 }); },
};
const answerSets: Array<[string, SetupAnswers, boolean]> = [
  ['none', {}, false],
  ['saved-join', { role: 'join', url: STATUS_URL }, false],
  ['flag-join', { role: 'join', url: STATUS_URL }, true],
  ['flag-create-local', { role: 'create', target: 'local' }, true],
  ['saved-create-cf', { role: 'create', target: 'cloudflare' }, false],
];
for (const [name, setup] of Object.entries(setups)) {
  it(`status retains the journey contract: ${name}`, async () => {
    setup();
    for (const [, answers, selected] of answerSets) {
      const outcome = async (fn: typeof observeStatusContract) => {
        const facts = await fn(fixture.home, { ...answers }, deps(), selected);
        return { json: JSON.stringify(facts), lines: renderSetupStatus(facts) };
      };
      const before = await outcome(observeStatusContract);
      const after = await outcome(observeSetupStatus);
      if (name === 'damagedMembership') {
        expect(after).not.toEqual(before);
        expect(after.lines.join('\n')).toContain(deploymentPath(SECOND, fixture.home));
      } else expect(after).toEqual(before);
    }
  });
}
