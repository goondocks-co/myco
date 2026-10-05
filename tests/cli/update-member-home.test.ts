import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
/**
 * `myco update` in a member home refreshes the agents the member's provisioning recorded, for the Deployment it
 * recorded, and runs none of 1.4's machine-wide passes over it (#1478, #1499). A home with no record is told how to set
 * its agents up, once, and nothing is set up on its own.
 */
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/update.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { readProvisionRecord, recordProvision } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';

let home: string;
let agentHome: string;
const saved = { HOME: process.env.HOME, MYCO_HOME: process.env.MYCO_HOME };
const settings = () => path.join(agentHome, '.claude', 'settings.json');
const member = (serverUrl: string) =>
  writeDeploymentMembership({ serverUrl, token: serverUrl === 'https://myco.example' ? 'A'.repeat(43) : 'B'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: home });
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-member-')));
  agentHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-agents-')));
  process.env.HOME = agentHome;
  process.env.MYCO_HOME = home;
  fs.mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
  member('https://myco.example');
  recordDefaultDeployment('https://myco.example', { mycoHome: home });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(agentHome, { recursive: true, force: true });
});

async function update(): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  try { await run([]); } finally { log.mockRestore(); }
  return lines.join('');
}

it('sets up again the agents provisioning recorded, with this build, and writes no 1.4 update stamp', async () => {
  recordProvision(home, { version: '2.0.0-beta.0', serverUrl: 'https://myco.example', agents: ['claude-code'] });
  expect(await update()).toContain('Capture is set up for Claude Code.');
  expect(fs.readFileSync(settings(), 'utf8')).toContain('--credential registry');
  expect(readProvisionRecord(home)).toMatchObject({ version: getPluginVersion(), agents: ['claude-code'] });
  expect(fs.readdirSync(home).filter((name) => name.includes('last-update'))).toEqual([]);
});

it('sets up nothing where no provisioning is recorded, and says how, once', async () => {
  expect(await update()).toContain('Myco has not set up your agents on this machine; run `myco member provision` to set them up.');
  expect(fs.existsSync(settings())).toBe(false);
  expect(readProvisionRecord(home)?.agents).toEqual([]);
  expect(await update()).not.toContain('run `myco member provision` to set them up');
  expect(fs.existsSync(settings())).toBe(false);
});

it('refreshes for the Deployment the record names where the home is a member of two and no folder names one', async () => {
  member('https://two.example');
  recordProvision(home, { version: '2.0.0-beta.0', serverUrl: 'https://two.example', agents: ['claude-code'] });
  const said = await update();
  expect(said).toContain('Capture is set up for Claude Code.');
  expect(said).not.toContain('--server');
  expect(fs.readFileSync(path.join(agentHome, '.claude.json'), 'utf8')).toContain('https://two.example');
  expect(readProvisionRecord(home)).toMatchObject({ serverUrl: 'https://two.example', agents: ['claude-code'] });
});
