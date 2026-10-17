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
import { runProvision } from '@myco/cli/member.js';
import { run } from '@myco/cli/update.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { readProvisionRecord, recordProvision } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';
import { claimSubsystem, readClaim, resolveClaimsHome, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/member/subsystem-claim.js';

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

async function update(args: string[] = []): Promise<string> {
  const lines: string[] = [];
  const consoleLog = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ') + '\n'); });
  const log = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  try { await run(args, { resolveRefs: async () => null, refreshMember: async () => { if (!runProvision(['--refresh'], { mycoHome: home, cwd: agentHome })) throw new Error('refresh failed'); } }); } finally { log.mockRestore(); consoleLog.mockRestore(); }
  return lines.join('');
}

it('sets up again the agents provisioning recorded, with this build, and writes no 1.4 update stamp', async () => {
  recordProvision(home, { version: '2.0.0-beta.0', serverUrl: 'https://myco.example', agents: ['claude-code'] });
  expect(await update()).toContain('Capture is set up for Claude Code.');
  expect(fs.readFileSync(settings(), 'utf8')).toContain('--credential registry');
  expect(readProvisionRecord(home)).toMatchObject({ version: getPluginVersion(), agents: ['claude-code'] });
  expect(fs.existsSync(path.join(home, 'last-update-version'))).toBe(false);
});

it('explicit skip still refreshes agents and releases the binary lease before provisioning', async () => {
  recordProvision(home, { version: '2.0.0-beta.0', serverUrl: 'https://myco.example', agents: ['claude-code'] });
  const said = await update(['--skip-binary']);
  expect(said).toContain('binary update skipped (--skip-binary requested)');
  expect(said).toContain('Capture is set up for Claude Code.');
  expect(fs.readFileSync(settings(), 'utf8')).toContain('--credential registry');
});

it('preserves global config and skill links under a peer claim until --claim explicitly transfers it', async () => {
  recordProvision(home, { version: '2.0.0-beta.0', serverUrl: 'https://myco.example', agents: ['claude-code'] });
  const peer = path.join(agentHome, 'peer-home');
  fs.mkdirSync(peer);
  claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, peer);
  const bytes = '{"userSetting": true}\n';
  fs.writeFileSync(settings(), bytes);
  const previousClaimsHome = process.env.MYCO_CLAIMS_HOME;
  process.env.MYCO_CLAIMS_HOME = path.join(home, 'fake-claims');
  try {
    expect(await update(['--skip-binary'])).toContain(`global agent setup is managed by ${peer}`);
    expect(fs.readFileSync(settings(), 'utf8')).toBe(bytes);
    expect(fs.existsSync(path.join(agentHome, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(agentHome, '.claude', 'skills'))).toBe(false);
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM)?.owner).toBe(peer);
    const said = await update(['--skip-binary', '--claim']);
    expect(said).toContain('now manages this machine');
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, resolveClaimsHome())?.owner).toBe(home);
    expect(fs.readFileSync(settings(), 'utf8')).toContain('--credential registry');
    expect(fs.existsSync(path.join(agentHome, '.claude.json'))).toBe(true);
    expect(fs.readdirSync(path.join(agentHome, '.claude', 'skills')).length).toBeGreaterThan(0);
  } finally {
    if (previousClaimsHome === undefined) delete process.env.MYCO_CLAIMS_HOME; else process.env.MYCO_CLAIMS_HOME = previousClaimsHome;
    process.exitCode = 0;
  }
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
