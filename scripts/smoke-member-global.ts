import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_VERSION, writeRegistryEntry } from '../packages/myco/src/member/registry.js';

const binary = process.argv[2];
if (!binary) throw new Error('Usage: bun scripts/smoke-member-global.ts <compiled-myco-binary>');
const serverUrl = 'https://127.0.0.1:9';
const token = 'A'.repeat(43);
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-smoke-')));
const agentHome = path.join(scratch, 'user');
const memberHome = path.join(scratch, 'member');
const project = path.join(scratch, 'project');
const env = { ...process.env, HOME: agentHome, CODEX_HOME: path.join(agentHome, '.codex'), CLAUDE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: path.join(agentHome, '.config'), MYCO_HOME: memberHome, MYCO_CLAIMS_HOME: memberHome };
const run = (command: string, args: string[], cwd = project): string => execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });

try {
  fs.mkdirSync(agentHome, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const installedBinary = path.join(memberHome, 'bin', process.platform === 'win32' ? 'myco.exe' : 'myco');
  fs.mkdirSync(path.dirname(installedBinary), { recursive: true });
  fs.copyFileSync(path.resolve(binary), installedBinary);
  fs.chmodSync(installedBinary, 0o755);
  run('git', ['init', '-q']);
  writeRegistryEntry({
    version: REGISTRY_VERSION, root: project, projectId: 'proj_smoke', serverUrl,
    token, machineId: 'machine_smoke', joinedAt: 1, updatedAt: 1,
  }, { mycoHome: memberHome });
  for (const agent of ['codex', 'claude-code', 'opencode', 'pi']) {
    assert.match(run(installedBinary, ['member', 'provision', agent]), /provisioned .+ globally/);
    assert.match(run(installedBinary, ['member', 'provision', agent]), /no global registration changes/);
  }
  assert.deepEqual(fs.readdirSync(project), ['.git']);
  const claude = JSON.parse(fs.readFileSync(path.join(agentHome, '.claude.json'), 'utf8'));
  assert.equal(claude.mcpServers.myco.url, `${serverUrl}/mcp`);
  const headers = JSON.parse(run(installedBinary, ['member', 'mcp-headers', '--credential', 'registry', '--server', serverUrl], agentHome));
  assert.equal(headers.authorization, `Bearer ${token}`);
  assert.equal(headers['x-myco-project'], undefined);
  console.log('PASS: compiled CLI provisions four agents globally, is idempotent, leaves the project untouched, and resolves MCP headers outside the project.');
  if (process.env.MYCO_SMOKE_CLAUDE) {
    assert.match(run(process.env.MYCO_SMOKE_CLAUDE, ['mcp', 'get', 'myco']), /User config/);
    console.log('PASS: Claude reads Myco from its user-wide MCP configuration.');
  }
  if (process.env.MYCO_SMOKE_CODEX) {
    const config = JSON.parse(run(process.env.MYCO_SMOKE_CODEX, ['mcp', 'get', 'myco', '--json']));
    assert.equal(config.transport.url, `${serverUrl}/mcp`);
    console.log('PASS: Codex reads Myco from its user-wide MCP configuration.');
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
