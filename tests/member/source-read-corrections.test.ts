import { describe, expect, it } from 'bun:test';
import fs, { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from '../support/fenced-fs.mjs';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceAccess, sourceAccessAllows, sourceToolAllows } from '@myco/runner/drivers/source-access.js';
import { claudeCodeDriver } from '@myco/runner/drivers/claude-code.js';
import { stubClaudeSource } from '../helpers/stub-claude-source.js';
import { acpDriver, runAsking, turnOver, type Channel } from '@myco/runner/drivers/acp.js';
import { harnessById } from '@myco/runner/harnesses.js';
import { selectExecution } from '@myco-server-worker/core/worker-selection.js';
import { runGrant } from '@myco/runner/drivers/grant.js';
import { answerPermission } from '@myco/runner/drivers/acp-permission.js';
import { runFilesystem } from '@myco/runner/drivers/codex.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

function fixture() {
  const scratchDir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-source-correction-')));
  const repo = join(scratchDir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(scratchDir, 'mcp.json'), '{"mcpServers":{}}');
  const outside = join(scratchDir, 'private.txt');
  writeFileSync(outside, 'FORBIDDEN_PRIVATE_CONTENT');
  writeFileSync(join(repo, 'source.txt'), 'ALLOWED_SOURCE_CONTENT');
  symlinkSync(outside, join(repo, 'escape'));
  symlinkSync(join(scratchDir, 'absent'), join(repo, 'dangling'));
  return { scratchDir, mcpConfigPath: join(scratchDir, 'mcp.json'), repo, outside, prompt: 'inspect', sourceReadOnly: true, credentialEnv: {} };
}

describe('source containment corrections', () => {
  it('allows checkout-wide and implicit searches while physically excluding outward and dangling links', () => {
    const spec = fixture();
    const policy = sourceAccess(spec.scratchDir);
    expect(sourceToolAllows(policy, 'Grep', { path: spec.repo, pattern: 'CONTENT' })).toBe(true);
    expect(sourceToolAllows(policy, 'Grep', { pattern: 'CONTENT' })).toBe(true);
    expect(sourceToolAllows(policy, 'Search', { pattern: 'CONTENT' })).toBe(true);
    expect(fs.existsSync(join(spec.repo, 'escape'))).toBe(false);
    expect(fs.lstatSync(join(spec.repo, 'source.txt')).isFile()).toBe(true);
    const output = execFileSync('find', [spec.repo, '-type', 'f'], { encoding: 'utf8' });
    expect(output).toContain('source.txt');
    expect(output).not.toContain('escape');
    expect(fs.readFileSync(spec.outside, 'utf8')).toBe('FORBIDDEN_PRIVATE_CONTENT');
  });
  it('refreshes the cached index synchronously for nested checkout changes', () => {
    const spec = fixture();
    mkdirSync(join(spec.repo, 'nested'));
    const policy = sourceAccess(spec.scratchDir);
    symlinkSync(spec.outside, join(spec.repo, 'nested', 'new-escape'));
    expect(sourceToolAllows(policy, 'Grep', { pattern: 'CONTENT' })).toBe(true);
    expect(fs.existsSync(join(spec.repo, 'nested', 'new-escape'))).toBe(false);
    expect(policy.excluded?.has(join(spec.repo, 'nested', 'new-escape'))).toBe(true);
  });
  it('never walks the tree per permission call on a large checkout', () => {
    const spec = fixture();
    fs.unlinkSync(join(spec.repo, 'escape'));
    fs.unlinkSync(join(spec.repo, 'dangling'));
    for (let dir = 0; dir < 250; dir++) {
      const root = join(spec.repo, `module-${dir}`);
      mkdirSync(root);
      for (let file = 0; file < 20; file++) writeFileSync(join(root, `${file}.ts`), 'source');
    }
    const policy = sourceAccess(spec.scratchDir);
    let walks = 0;
    const probe = { ...fs, readdirSync: () => { walks++; throw new Error('per-call traversal'); } };
    let slowest = 0;
    for (let call = 0; call < 30; call++) {
      const started = performance.now();
      expect(sourceAccessAllows(policy, [spec.repo], true, probe)).toBe(true);
      slowest = Math.max(slowest, performance.now() - started);
    }
    expect(walks).toBe(0);
    expect(slowest).toBeLessThan(50);
  });
  it('refuses search when the final metadata operation exhausts its budget', () => {
    const spec = fixture();
    const policy = sourceAccess(spec.scratchDir);
    const original = performance.now;
    const times = [0, 0, 101];
    try {
      performance.now = () => times.shift() ?? 101;
      expect(sourceToolAllows(policy, 'Grep', { pattern: 'CONTENT' })).toBe(false);
    } finally { performance.now = original; }
  });
  it('supports literal special-character and Windows run paths without weaker file allow rules', () => {
    const spec = fixture();
    const named = join(spec.scratchDir, process.platform === 'win32' ? 'Bob (work) []{},' : 'Bob (work) []{}*?!,');
    mkdirSync(join(named, 'repo'), { recursive: true });
    expect(runGrant({ ...spec, scratchDir: named }, { sourceGit: 'none', asking: { kind: 'native' } }, 'win32').rules).toEqual(['mcp__myco']);
    const grant = runGrant(spec, { sourceGit: 'none', asking: { kind: 'native' } }, 'win32');
    expect(grant.rules.some((rule) => /^(Read|Glob|Grep)(\(|$)/.test(rule))).toBe(false);
    const policy = { base: 'C:\\run', root: 'C:\\run\\repo', files: [] };
    const probe = { ...fs, realpathSync: (path: PathLike) => String(path) };
    expect(sourceAccessAllows(policy, ['C:\\run\\repo\\source.txt'], false, probe, win32)).toBe(true);
    expect(sourceAccessAllows(policy, ['C:\\Users\\Bob (work)\\private'], false, probe, win32)).toBe(false);
  });
  for (const failure of ['timeout', 'throw'] as const) {
    it(`fails closed when the native hook ${failure}s, including in-cwd reads`, async () => {
      const spec = fixture();
      const mcpConfigPath = join(spec.scratchDir, 'mcp.json');
      writeFileSync(mcpConfigPath, '{"mcpServers":{}}');
      const bin = stubClaudeSource(['{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'], [
        { tool_name: 'Read', tool_input: { file_path: join(spec.repo, 'source.txt') } },
        { tool_name: 'Read', tool_input: { file_path: spec.outside } },
      ], failure);
      const previous = process.env.PATH;
      try {
        process.env.PATH = `${bin}:${previous}`;
        for await (const _event of claudeCodeDriver.run({ ...spec, mcpConfigPath }, new AbortController().signal)) { /* consume */ }
      } finally { process.env.PATH = previous; }
      expect(JSON.parse(fs.readFileSync(join(bin, 'decisions.json'), 'utf8'))).toEqual(['deny', 'deny']);
      expect(fs.readFileSync(join(bin, 'cwd.txt'), 'utf8')).toBe(fs.realpathSync(spec.repo));
      const args = fs.readFileSync(join(bin, 'argv.txt'), 'utf8').split('\n');
      expect(args).not.toContain('--permission-prompts');
    });
  }
  it('grants the physical npm-shim installation directory read-only', () => {
    const spec = fixture();
    const home = join(spec.scratchDir, 'home');
    const install = join(spec.scratchDir, 'npm', 'node_modules', '@openai', 'codex');
    mkdirSync(home);
    mkdirSync(join(install, 'bin'), { recursive: true });
    mkdirSync(join(install, 'vendor'));
    writeFileSync(join(install, 'package.json'), '{"name":"@openai/codex"}');
    writeFileSync(join(install, 'vendor', 'runtime'), 'synthetic runtime');
    const executable = join(install, 'bin', 'codex.js');
    writeFileSync(executable, '#!/usr/bin/env node\n');
    writeFileSync(join(install, 'bin', 'runtime.js'), 'export {};');
    const shim = join(spec.scratchDir, 'codex');
    symlinkSync(executable, shim);
    const rules = runFilesystem(spec, home, shim, null);
    expect(rules[fs.realpathSync(executable)]).toBe('read');
    expect(rules[fs.realpathSync(join(install, 'bin'))]).toBe('read');
    expect(rules[fs.realpathSync(install)]).toBe('read');
    expect(rules[fs.realpathSync(home)]).toBe('deny');
  });
  it('refuses installation directory grants that expose the operator home or protected homes', () => {
    const spec = fixture();
    const operator = join(spec.scratchDir, 'operator');
    const redirected = join(spec.scratchDir, 'redirected');
    mkdirSync(operator);
    mkdirSync(redirected);
    mkdirSync(join(operator, '.codex', 'bin'), { recursive: true });
    mkdirSync(join(operator, 'bin'));
    writeFileSync(join(operator, 'package.json'), '{"name":"@openai/codex"}');
    writeFileSync(join(operator, '.codex', 'package.json'), '{"name":"@openai/codex"}');
    const temporary = removeWhenTestsEnd(join(tmpdir(), `codex-install-${basename(spec.scratchDir)}`));
    writeFileSync(temporary, 'synthetic executable');
    expect(() => runFilesystem(spec, redirected, temporary, null)).toThrow('Unsafe Codex installation directory');
    const previous = process.env.HOME;
    try {
      process.env.HOME = operator;
      for (const executable of [join(operator, 'codex'), join(operator, 'bin', 'codex'), join(operator, '.codex', 'bin', 'codex')]) {
        writeFileSync(executable, 'synthetic executable');
        expect(() => runFilesystem(spec, redirected, executable, null)).toThrow('Unsafe Codex installation directory');
      }
    } finally { process.env.HOME = previous; }
  });
  it('preserves prompt text while preventing native file-mention expansion', async () => {
    const spec = fixture();
    const prompt = `Inspect @${spec.outside} and @source.txt; literal email bob@example.org`;
    const bin = stubClaudeSource(['{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}']);
    const previous = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previous}`;
      for await (const _event of claudeCodeDriver.run({ ...spec, prompt }, new AbortController().signal)) { /* consume */ }
    } finally { process.env.PATH = previous; }
    const sent = JSON.parse(fs.readFileSync(join(bin, 'prompt.json'), 'utf8'));
    const text = typeof sent === 'string' ? sent : sent.map((block: { text: string }) => block.text).join('');
    expect(text).not.toContain('@');
    expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toBe(prompt);
  });
  it('refuses an installation containing a protected Myco home before that home exists', () => {
    const spec = fixture();
    const home = join(spec.scratchDir, 'redirected');
    const install = join(spec.scratchDir, 'installation');
    mkdirSync(home);
    mkdirSync(install);
    const executable = join(install, 'codex');
    writeFileSync(executable, 'synthetic executable');
    const previous = process.env.MYCO_HOME;
    try {
      process.env.MYCO_HOME = join(install, 'future-myco-home');
      expect(() => runFilesystem(spec, home, executable, null)).toThrow('Unsafe Codex installation directory');
    } finally { process.env.MYCO_HOME = previous; }
  });
  it('OpenCode explicitly asks for each native source-read tool from its manifest', () => {
    const config = JSON.parse(runAsking(harnessById('opencode'), 'source-agent').env.OPENCODE_CONFIG_CONTENT!);
    for (const tool of ['read', 'glob', 'grep', 'list', 'external_directory']) expect(config.agent['source-agent'].permission[tool]).toBe('ask');
  });
  it('Cursor fails closed before launching a source run, and is withheld at selection', async () => {
    const spec = fixture();
    expect(() => runGrant(spec, harnessById('cursor')!)).toThrow('source_read_unavailable:cursor');
    const events = [];
    for await (const event of acpDriver('cursor').run({ ...spec, mcpConfigPath: join(spec.scratchDir, 'mcp.json') }, new AbortController().signal)) events.push(event);
    expect(events).toEqual([{ kind: 'ended', stop: 'error', code: 'launch_failed', detail: 'source_read_unavailable:cursor' }]);
    const result = await selectExecution({ harnessCredentialSource: 'worker-login' }, 'vault-seed', [{ id: 'cursor', authenticated: true, profile: { model: 'none', efforts: [] } }], new Map(), async () => { throw new Error('unbounded source harness must not open a login'); });
    expect(result).toEqual({ selected: null, reason: 'source_read_unavailable:cursor' });
  });
  it('OpenCode uses the checkout cwd for default searches and carries the standing instruction', async () => {
    const spec = fixture();
    const mcpConfigPath = join(spec.scratchDir, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { myco: { type: 'http', url: 'https://deployment.example', headers: {} } } }));
    writeFileSync(join(spec.scratchDir, 'AGENTS.md'), 'STANDING_SOURCE_RULE');
    let receive: (line: string) => void = () => {};
    const requested: Array<{ method: string; params: Record<string, unknown> }> = [];
    const channel: Channel = {
      onLine: (read) => { receive = read; }, onClose: () => {},
      write: (line) => {
        const call = JSON.parse(line);
        requested.push(call);
        const result = call.method === 'session/new' ? { sessionId: 'session', modes: { currentModeId: 'source-agent' } } : call.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
        receive(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }) + '\n');
      },
    };
    for await (const _event of turnOver(channel, 'opencode', { ...spec, mcpConfigPath }, () => '', async () => ({ ok: true, names: new Set() }), { asking: runAsking(harnessById('opencode'), 'source-agent') })) { /* consume */ }
    expect(requested.find((call) => call.method === 'session/new')?.params.cwd).toBe(fs.realpathSync(spec.repo));
    expect(JSON.stringify(requested.find((call) => call.method === 'session/prompt')?.params)).toContain('STANDING_SOURCE_RULE');
  });
  it('refuses commands with dangling or nonexistent working directories', () => {
    const spec = fixture();
    const grant = runGrant(spec, { sourceGit: 'shim', asking: { kind: 'native' } });
    symlinkSync(join(spec.scratchDir, 'missing'), join(spec.scratchDir, 'dangling-cwd'));
    const options = [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }];
    for (const cwd of ['dangling-cwd', 'missing']) {
      const result = answerPermission(grant, new Set(), 'session', { sessionId: 'session', options }, { kind: 'execute', rawInput: { command: 'git log', cwd } });
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'deny' });
    }
  });
});
