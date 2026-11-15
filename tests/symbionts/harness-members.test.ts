import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as logoutCli } from '@myco/cli/logout.js';
import { run as memberCli } from '@myco/cli/member.js';
import { normalizeHookInput } from '@myco/hooks/normalize.js';
import { detectedProvisionLines, provisionDetectedAgents } from '@myco/cli/member.js';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { readProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { detectMachineInstalledSymbionts } from '@myco/symbionts/detect.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

let scratch: string;
let home: string;
let mycoHome: string;
let restore: () => void;
const argv = process.argv;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-harness-members-'));
  home = path.join(scratch, 'home');
  mycoHome = path.join(home, '.myco');
  restore = bindSandboxChildHome(scratch, { HOME: home, MYCO_HOME: mycoHome });
  writeRegistryEntry({ version: REGISTRY_VERSION, root: scratch, projectId: 'proj_1',
    serverUrl: 'https://myco.example', token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
});
afterEach(() => {
  process.argv = argv;
  restore();
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = 0;
});

const targets = [
  { name: 'copilot', hooks: '.copilot/hooks/myco-hooks.json', mcp: '.copilot/mcp-config.json', skills: '.agents/skills', key: 'hooks', event: 'SessionStart' },
  { name: 'antigravity', hooks: '.gemini/config/hooks.json', mcp: '.gemini/config/mcp_config.json', skills: '.gemini/config/skills', key: 'myco', event: 'SessionStart' },
  { name: 'windsurf', hooks: '.codeium/windsurf/hooks.json', mcp: '.codeium/windsurf/mcp_config.json', skills: '.agents/skills', key: 'hooks', event: 'pre_user_prompt' },
];
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(home, file), 'utf8'));
const write = (file: string, value: unknown) => {
  const target = path.join(home, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
};

for (const target of targets) it(`provisions and removes ${target.name} through the member CLI, preserving other configuration`, async () => {
  // Hook layouts: docs.github.com/en/copilot/reference/hooks-reference,
  // antigravity.google/docs/hooks, docs.windsurf.com/de/windsurf/cascade/hooks.
  const userHook = { command: 'echo user-hook' };
  const user = { [target.key]: { [target.event]: [userHook], ...(target.key === 'myco' ? { enabled: true } : {}) }, userPreference: true };
  write(target.hooks, user);
  write(target.mcp, { mcpServers: { user: { command: 'user-server' } }, preference: true });
  const editor = 'Library/Application Support/Code/User/mcp.json';
  write(editor, { servers: { user: { command: 'editor-server' } } });
  const stderr: string[] = [];
  const run = (args: string[]) => memberCli(['provision', ...args, '--server', 'https://myco.example'], {
    cwd: scratch, mycoHome, env: {}, stdout: () => {}, stderr: line => stderr.push(line),
  });
  await run([target.name]);
  expect(stderr).toEqual([]);
  expect(read(target.hooks)[target.key][target.event]).toContainEqual(userHook);
  expect(read(target.mcp)).toMatchObject({ preference: true, mcpServers: {
    user: { command: 'user-server' }, myco: { args: ['mcp', '--credential', 'registry'] },
  } });
  expect(readProvisionRecord(mycoHome)?.agents).toContain(target.name);
  expect(fs.existsSync(path.join(home, target.skills, 'myco', 'SKILL.md'))).toBe(true);
  await run([target.name]);
  await run(['--remove', target.name]);
  expect(read(target.hooks)).toMatchObject(user);
  expect(read(target.mcp)).toEqual({ preference: true, mcpServers: { user: { command: 'user-server' } } });
  expect(readProvisionRecord(mycoHome)?.agents ?? []).not.toContain(target.name);
  expect(fs.existsSync(path.join(home, target.skills, 'myco'))).toBe(false);
  expect(read(editor)).toEqual({ servers: { user: { command: 'editor-server' } } });
});

it('normalizes vendor hook payloads without inventing unavailable fields', () => {
  // Inputs from https://docs.github.com/en/copilot/reference/hooks-reference#posttooluse--posttooluse
  process.argv = ['bun', 'myco', '--symbiont', 'copilot'];
  expect(normalizeHookInput({ session_id: 'c1', cwd: '/workspace', tool_name: 'view',
    tool_input: { path: 'README.md' }, tool_result: { result_type: 'success', text_result_for_llm: 'read' } }))
    .toMatchObject({ agent: 'copilot', sessionId: 'c1', toolName: 'view',
      toolInput: { path: 'README.md' }, toolOutput: { result_type: 'success', text_result_for_llm: 'read' } });
  // https://antigravity.google/docs/hooks#posttooluse
  process.argv = ['bun', 'myco', '--symbiont', 'antigravity'];
  const antigravity = normalizeHookInput({ conversationId: 'a1', workspacePaths: ['/workspace'],
    transcriptPath: '/workspace/transcript.jsonl', stepIdx: 5, toolCall: { name: 'view_file', args: { AbsolutePath: '/workspace/README.md' } } });
  expect(antigravity).toMatchObject({ sessionId: 'a1', transcriptPath: '/workspace/transcript.jsonl',
    toolName: 'view_file', toolInput: { AbsolutePath: '/workspace/README.md' } });
  expect(antigravity.toolOutput).toBeUndefined();
  // https://docs.windsurf.com/de/windsurf/cascade/hooks#post_mcp_tool_use
  process.argv = ['bun', 'myco', '--symbiont', 'windsurf'];
  expect(normalizeHookInput({ trajectory_id: 'w1', agent_action_name: 'post_mcp_tool_use',
    tool_info: { mcp_tool_name: 'search', mcp_result: 'found' } }))
    .toMatchObject({ sessionId: 'w1', toolName: 'post_mcp_tool_use', toolOutput: 'found' });
});

it('retains shared skills for another member and removes all owned skills on the last logout', async () => {
  const deps = { cwd: scratch, mycoHome, env: {}, stdout: () => {}, stderr: () => {} };
  const provision = (args: string[]) => memberCli(['provision', ...args, '--server', 'https://myco.example'], deps);
  await provision(['codex']);
  await provision(['copilot']);
  await provision(['--remove', 'copilot']);
  expect(fs.existsSync(path.join(home, '.agents/skills/myco/SKILL.md'))).toBe(true);
  for (const target of targets) await provision([target.name]);
  expect(await logoutCli(['https://myco.example', '--local-only'], { ...deps, fetch: async () => Response.json({}, { status: 401 }) })).toBe(true);
  for (const target of targets) {
    expect(fs.existsSync(path.join(home, target.mcp))).toBe(false);
    expect(fs.existsSync(path.join(home, target.skills, 'myco'))).toBe(false);
  }
  expect(readProvisionRecord(mycoHome)).toBeNull();
});


it('does not enroll absent harnesses from configuration directories alone', () => {
  const previousPath = process.env.PATH;
  process.env.PATH = process.platform === 'win32' ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin';
  try {
    for (const dir of ['.claude', '.codex', '.copilot', '.gemini', '.codeium/windsurf']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    const found = provisionDetectedAgents(mycoHome, 'https://myco.example', null);
    expect(detectedProvisionLines(found)).toEqual(['Capture is set up for Claude Code, Codex.']);
    expect(readProvisionRecord(mycoHome)?.agents).toEqual(['claude-code', 'codex']);
    for (const target of targets) {
      expect(fs.existsSync(path.join(home, target.hooks))).toBe(false);
      expect(fs.existsSync(path.join(home, target.mcp))).toBe(false);
    }
  } finally { process.env.PATH = previousPath; }
});

it('removes a Myco-only Copilot hooks file completely', async () => {
  const deps = { cwd: scratch, mycoHome, env: {}, stdout: () => {}, stderr: () => {} };
  await memberCli(['provision', 'copilot', '--server', 'https://myco.example'], deps);
  expect(fs.existsSync(path.join(home, targets[0]!.hooks))).toBe(true);
  await memberCli(['provision', '--remove', 'copilot'], deps);
  expect(fs.existsSync(path.join(home, targets[0]!.hooks))).toBe(false);
});

it('detects the other agents when one agent\'s directory cannot be read', async () => {
  for (const dir of ['.claude', '.codex']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.symlinkSync(path.join(home, '.cursor'), path.join(home, '.cursor'));
  expect(detectMachineInstalledSymbionts().map(manifest => manifest.name)).toEqual(expect.arrayContaining(['claude-code', 'codex']));
});

it("keeps a person's own Cursor hooks file when Myco's hooks are taken out again", async () => {
  const deps = { cwd: scratch, mycoHome, env: {}, stdout: () => {}, stderr: () => {} };
  const file = path.join(home, '.cursor/hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"version":1}');
  await memberCli(['provision', 'cursor', '--server', 'https://myco.example'], deps);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks).toBeDefined();
  await memberCli(['provision', '--remove', 'cursor'], deps);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1 });
});

it('keeps shared skills when the provision record and destination cannot be read', async () => {
  const deps = { cwd: scratch, mycoHome, env: {}, stdout: () => {}, stderr: () => {} };
  await memberCli(['provision', 'codex', '--server', 'https://myco.example'], deps);
  await memberCli(['provision', 'copilot', '--server', 'https://myco.example'], deps);
  const { provisionRecordPath } = await import('@myco/symbionts/member-provision-record.js');
  fs.writeFileSync(provisionRecordPath(mycoHome), '{torn');
  fs.rmSync(path.join(mycoHome, 'member', 'deployments'), { recursive: true, force: true });
  fs.rmSync(path.join(mycoHome, 'member', 'registry'), { recursive: true, force: true });
  await memberCli(['provision', '--remove', 'copilot'], deps);
  expect(fs.existsSync(path.join(home, '.agents/skills/myco/SKILL.md'))).toBe(true);
  expect(fs.readFileSync(provisionRecordPath(mycoHome), 'utf8')).toBe('{torn');
});


it('keeps shared skills when a peer configuration cannot be inspected', async () => {
  const deps = { cwd: scratch, mycoHome, env: {}, stdout: () => {}, stderr: () => {} };
  for (const agent of ['codex', 'copilot']) await memberCli(['provision', agent, '--server', 'https://myco.example'], deps);
  const { recordDefaultDeployment } = await import('@myco/member/default-deployment.js');
  const { provisionRecordPath } = await import('@myco/symbionts/member-provision-record.js');
  recordDefaultDeployment('https://myco.example', { mycoHome });
  fs.writeFileSync(provisionRecordPath(mycoHome), '{torn');
  fs.writeFileSync(path.join(home, '.codex/hooks.json'), '{unreadable');
  await memberCli(['provision', '--remove', 'copilot'], deps);
  expect(fs.existsSync(path.join(home, '.agents/skills/myco/SKILL.md'))).toBe(true);
});
