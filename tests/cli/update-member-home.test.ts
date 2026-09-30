/**
 * `myco update` in a member home refreshes the member's agent setup, and runs none of 1.4's machine-wide passes over
 * it (#1478, #1499).
 */
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/update.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { readProvisionRecord } from '@myco/symbionts/member-provision-record.js';

let home: string;
let agentHome: string;
const saved = { HOME: process.env.HOME, MYCO_HOME: process.env.MYCO_HOME };
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-member-')));
  agentHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-agents-')));
  process.env.HOME = agentHome;
  process.env.MYCO_HOME = home;
  fs.mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
  writeDeploymentMembership({ serverUrl: 'https://myco.example', token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: home });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(agentHome, { recursive: true, force: true });
});

it('sets the member\'s agents up again with this build, and writes no 1.4 update stamp', async () => {
  const log = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await run([]); } finally { log.mockRestore(); }
  expect(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')).toContain('--credential registry');
  expect(readProvisionRecord(home)?.agents).toContain('claude-code');
  expect(fs.readdirSync(home).filter((name) => name.includes('last-update'))).toEqual([]);
});
