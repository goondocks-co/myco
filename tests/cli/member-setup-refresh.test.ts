/**
 * A member's agent setup kept current as releases change it (#1499).
 *
 * Provisioning seeds the home's skills and links them into each agent's global skills folder, leaving what another
 * installation or the person put there as it is. It records which agents it set up with which build, and a refresh
 * sets those agents up again with the build that runs it; `myco doctor` names drift and the one command that fixes it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProvision } from '@myco/cli/member.js';
import { setupChecks } from '@myco/cli/member-doctor.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { readProvisionRecord, recordProvision } from '@myco/symbionts/member-provision-record.js';
import { BUNDLED_SKILLS } from '@myco/symbionts/skills.generated.js';
import { getPluginVersion } from '@myco/version.js';

const SERVER = 'https://myco.example';
const SKILLS = Object.keys(BUNDLED_SKILLS).sort();

describe('a member\'s agent setup', () => {
  let home: string;
  let agentHome: string;
  let previousHome: string | undefined;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-home-')));
    agentHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-agents-')));
    previousHome = process.env.HOME;
    process.env.HOME = agentHome;
    writeDeploymentMembership({ serverUrl: SERVER, token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 } as never, { mycoHome: home });
    fs.mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(agentHome, '.codex'), { recursive: true });
    out = [];
    err = [];
    process.exitCode = 0;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(agentHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  const provision = (args: string[] = []) => runProvision(args, { mycoHome: home, cwd: agentHome, agents: () => ['claude-code', 'codex'], stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  const link = (folder: string, name: string) => { try { return fs.readlinkSync(path.join(agentHome, folder, name)); } catch { return null; } };

  it('seeds the home\'s skills and links every one into each agent\'s global skills folder, once', () => {
    expect(provision()).toBe(true);
    for (const name of SKILLS) {
      expect(fs.existsSync(path.join(home, 'skills', name, 'SKILL.md'))).toBe(true);
      expect(link('.claude/skills', name)).toBe(path.join(home, 'skills', name));
      expect(link('.agents/skills', name)).toBe(path.join(home, 'skills', name));
    }
    const before = fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8');
    out = [];
    expect(provision()).toBe(true);
    expect(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(out).toEqual(['Capture is set up for Claude Code, Codex.']);
  });

  it('leaves a skill another installation links, and one the person put there, as they are; replaces a dead link; removes a retired one of its own', () => {
    const folder = path.join(agentHome, '.claude', 'skills');
    fs.mkdirSync(folder, { recursive: true });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-other-install-'));
    fs.mkdirSync(path.join(other, SKILLS[0]));
    fs.symlinkSync(path.join(other, SKILLS[0]), path.join(folder, SKILLS[0]));
    fs.mkdirSync(path.join(folder, SKILLS[1]));
    fs.writeFileSync(path.join(folder, SKILLS[1], 'SKILL.md'), 'mine');
    fs.symlinkSync(path.join(other, 'gone'), path.join(folder, SKILLS[2]));
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.symlinkSync(path.join(home, 'skills', 'retired-skill'), path.join(folder, 'retired-skill'));
    try {
      expect(provision()).toBe(true);
      expect(link('.claude/skills', SKILLS[0])).toBe(path.join(other, SKILLS[0]));
      expect(fs.readFileSync(path.join(folder, SKILLS[1], 'SKILL.md'), 'utf8')).toBe('mine');
      expect(link('.claude/skills', SKILLS[2])).toBe(path.join(home, 'skills', SKILLS[2]));
      expect(fs.existsSync(path.join(folder, 'retired-skill')) || link('.claude/skills', 'retired-skill') !== null).toBe(false);
      expect(out.join('\n')).toContain(`Left ${SKILLS[0]}, ${SKILLS[1]} in ${folder} as they are`);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('records the agents it set up with this build, and a refresh sets them up again after a release changed them', () => {
    expect(provision()).toBe(true);
    expect(readProvisionRecord(home)).toMatchObject({ version: getPluginVersion(), serverUrl: SERVER, agents: ['claude-code', 'codex'] });
    // An older build set these up, and its hooks and a skill link are gone.
    recordProvision(home, { version: '2.0.0-beta.0', serverUrl: SERVER, agents: ['claude-code', 'codex'] }, { replace: true });
    fs.rmSync(path.join(agentHome, '.claude', 'settings.json'));
    fs.unlinkSync(path.join(agentHome, '.agents', 'skills', SKILLS[0]));
    expect(setupChecks(home)[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining('myco member provision --refresh') });
    out = [];
    expect(runProvision(['--refresh'], { mycoHome: home, cwd: agentHome, agents: () => [], stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
    expect(fs.readFileSync(path.join(agentHome, '.claude', 'settings.json'), 'utf8')).toContain('--credential registry');
    expect(link('.agents/skills', SKILLS[0])).toBe(path.join(home, 'skills', SKILLS[0]));
    expect(readProvisionRecord(home)).toMatchObject({ version: getPluginVersion(), agents: ['claude-code', 'codex'] });
    expect(setupChecks(home)[0]).toMatchObject({ status: 'ok' });
  });

  it('names drift in doctor: nothing recorded, another build, or a skill gone', () => {
    expect(setupChecks(home)[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining('Run `myco member provision`') });
    expect(provision()).toBe(true);
    expect(setupChecks(home)[0].status).toBe('ok');
    expect(setupChecks(home, '9.9.9')[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining(`set up by Myco ${getPluginVersion()}; this is 9.9.9`) });
    fs.unlinkSync(path.join(agentHome, '.claude', 'skills', SKILLS[0]));
    expect(setupChecks(home)[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining(`Claude Code (${SKILLS[0]})`) });
  });
});
