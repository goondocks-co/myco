import { describe, expect, it } from 'bun:test';
import { COMMANDS, helpForCommand, renderTopLevelHelp } from '@myco/cli/command-registry.js';
import { MEMBER_COMMANDS, MEMBER_HELP } from '@myco/cli/member.js';
import { LOGIN_HELP } from '@myco/cli/login.js';
import { MEMBER_VERBS } from '@myco/cli/member-verbs.js';

function helpNames(help: string): string[] {
  return [...new Set([...help.matchAll(/^  ([a-z][a-z-]*)\b/gm), ...help.matchAll(/alias: ([a-z-]+)/g)].map(match => match[1]))].sort();
}

function assertHelpMatches(commands: Record<string, unknown>, help: string): void {
  expect(helpNames(help)).toEqual(Object.keys(commands).sort());
}

const publicCommands = Object.fromEntries(Object.entries(COMMANDS).filter(([name, command]) => !command.hidden || (command.aliasFor && !name.startsWith('-'))));
const publicMemberCommands = Object.fromEntries(Object.entries(MEMBER_COMMANDS).filter(([, command]) => !command.hidden));

describe('dispatch and help share registrations', () => {
  it('lists every top-level handler, and only registered handlers', async () => {
    assertHelpMatches(publicCommands, renderTopLevelHelp());
    for (const [name, command] of Object.entries(COMMANDS)) {
      expect(typeof command.run).toBe('function');
      expect(command.description.trim().length).toBeGreaterThan(0);
      expect((await helpForCommand(name)).length).toBeGreaterThan(0);
    }
    for (const verb of MEMBER_VERBS) expect(COMMANDS[verb]).toBeDefined();
  });

  it('lists every member handler, and only registered handlers', () => {
    assertHelpMatches(publicMemberCommands, MEMBER_HELP);
    for (const [name, command] of Object.entries(publicMemberCommands)) {
      expect(typeof command.run).toBe('function');
      expect(helpNames(command.help)).toEqual([name]);
    }
    expect(MEMBER_COMMANDS.provision.help).toContain('--refresh');
    expect(COMMANDS.remove.usage).toContain('--purge');
    expect(COMMANDS.remove.usage).toContain('--allow-deployment-loss');
  });

  for (const [label, commands, help] of [
    ['top-level', publicCommands, renderTopLevelHelp()],
    ['member', publicMemberCommands, MEMBER_HELP],
  ] as const) {
    it(label + ': rejects a dispatched verb missing from help', () => {
      expect(() => assertHelpMatches({ ...commands, undocumented: { run: async () => {} } }, help)).toThrow();
    });
    it(label + ': rejects a help entry without a dispatched verb', () => {
      expect(() => assertHelpMatches(commands, help + '\n  imaginary    Has no dispatcher\n')).toThrow();
    });
  }

  it('preserves retired daemon help without listing a 1.4 runtime command', async () => {
    expect(await helpForCommand('daemon')).toContain('Usage: myco daemon [kill]');
    expect(renderTopLevelHelp()).not.toContain('daemon');
    expect(renderTopLevelHelp()).not.toMatch(/^  (?:hook|mcp|upgrade)\b/m);
    expect(renderTopLevelHelp().match(/alias: upgrade/g)).toHaveLength(1);
    expect(MEMBER_HELP).not.toContain('--no-worker');
    expect(await helpForCommand('unknown')).toContain('Usage: myco unknown [args]');
  });

  it('describes Deployment invitations without promising project-bound invites', () => {
    expect(LOGIN_HELP).toContain('Deployment invitations');
    expect(LOGIN_HELP).toContain('myco member join');
    expect(LOGIN_HELP).not.toContain('project-bound invitation');
    expect(LOGIN_HELP).not.toContain('invite names');
  });
});
