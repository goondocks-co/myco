/**
 * `myco open` opens a Deployment's dashboard: the one the current repository joined, else this machine's default.
 * With neither it opens nothing, never the retired 1.4 daemon, and says how to join one.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from '@myco/cli/open.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { JOIN_A_DEPLOYMENT } from '@myco/member/join-guidance.js';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

function scratch(): { home: string; root: string; outside: string } {
  const dir = removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-open-'))));
  const root = path.join(dir, 'repo');
  const outside = path.join(dir, 'elsewhere');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(outside, '.git'), { recursive: true });
  return { home: path.join(dir, '.home'), root, outside };
}

const join = (home: string, root: string, serverUrl: string): void => {
  writeRegistryEntry({
    version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl, token: 'mt_' + 'a'.repeat(40),
    root, machineId: 'machine_1', joinedAt: 0, updatedAt: 0,
  }, { mycoHome: home });
};

describe('myco open', () => {
  it('opens the Deployment the repository joined', async () => {
    const { home, root } = scratch();
    join(home, root, 'https://deployment.example/');
    const opened: string[] = [];
    expect(await run([], { cwd: root, mycoHome: home, openBrowser: (url) => opened.push(url) })).toBe(true);
    expect(opened).toEqual(['https://deployment.example/']);
  });

  it("opens this machine's default Deployment from a repository with no connection of its own", async () => {
    const { home, root, outside } = scratch();
    join(home, root, 'https://default.example');
    recordDefaultDeployment('https://default.example', { mycoHome: home });
    const opened: string[] = [];
    expect(await run([], { cwd: outside, mycoHome: home, openBrowser: (url) => opened.push(url) })).toBe(true);
    expect(opened).toEqual(['https://default.example/']);
  });

  it('opens nothing with no Deployment, and says how to join one', async () => {
    const { home, root } = scratch();
    const opened: string[] = [];
    const said: string[] = [];
    expect(await run([], { cwd: root, mycoHome: home, openBrowser: (url) => opened.push(url), stderr: (line) => said.push(line) })).toBe(false);
    expect(opened).toEqual([]);
    expect(said).toEqual([`This machine has not joined a Deployment, so there is no dashboard to open. ${JOIN_A_DEPLOYMENT}`]);
  });
});
