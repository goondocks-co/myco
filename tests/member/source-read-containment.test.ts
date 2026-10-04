import { describe, expect, it } from 'bun:test';
import fencedFs, { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from '../support/fenced-fs.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { answerPermission } from '@myco/runner/drivers/acp-permission.js';
import { runGrant } from '@myco/runner/drivers/grant.js';
import { runFilesystem } from '@myco/runner/drivers/codex.js';
import { HARNESSES } from '@myco/runner/harnesses.js';
import { canOfferHarness, canReadSource } from '@goondocks/myco-shared/execution-profile';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
import { claudeCodeDriver } from '@myco/runner/drivers/claude-code.js';
import { stubClaudeSource } from '../helpers/stub-claude-source.js';
import { ToolCalls } from '@myco/runner/drivers/acp-permission.js';

const { renameSync } = fencedFs;

function fixture() {
  const parent = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-source-bound-')));
  const scratchDir = join(parent, 'run');
  const repo = join(scratchDir, 'repo');
  const home = join(parent, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home);
  const mcpConfigPath = join(scratchDir, 'mcp.json');
  const outside = join(parent, 'other-project.txt');
  writeFileSync(mcpConfigPath, 'synthetic connection');
  writeFileSync(join(scratchDir, 'CLAUDE.md'), 'Standing source run instructions');
  writeFileSync(outside, 'synthetic private file');
  writeFileSync(join(home, 'auth.json'), 'synthetic login');
  writeFileSync(join(repo, 'README.md'), 'source');
  mkdirSync(join(repo, 'safe'));
  writeFileSync(join(repo, 'safe', 'a.ts'), 'source');
  mkdirSync(join(parent, 'other', 'dir'), { recursive: true });
  writeFileSync(join(parent, 'other', 'secret'), 'outside');
  writeFileSync(join(repo, 'secret'), 'source');
  symlinkSync(join(parent, 'other', 'dir'), join(repo, 'link'));
  symlinkSync(outside, join(repo, 'escape'));
  symlinkSync(home, join(repo, 'escape-dir'));
  return { scratchDir, mcpConfigPath, repo, home, outside, prompt: 'inspect', credentialEnv: {}, sourceReadOnly: true };
}

const options = [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }];

describe('source file permission boundary (#1636)', () => {
  it('refuses source roots and declared instructions that alias host files', () => {
    const spec = fixture();
    renameSync(spec.repo, join(spec.scratchDir, 'saved-repo'));
    symlinkSync(spec.home, spec.repo);
    expect(() => runGrant(spec, { sourceGit: 'none', asking: { kind: 'native' } })).toThrow('Source checkout');
    const instructions = fixture();
    renameSync(join(instructions.scratchDir, 'CLAUDE.md'), join(instructions.scratchDir, 'saved-instructions'));
    symlinkSync(instructions.outside, join(instructions.scratchDir, 'CLAUDE.md'));
    expect(() => runGrant(instructions, { sourceGit: 'none', asking: { kind: 'native' } })).toThrow('Run input');
  });
  for (const harness of HARNESSES.filter((harness) => canOfferHarness(harness.asking) && canReadSource(harness.asking))) {
    it(`${harness.id} scopes file grants to the checkout`, () => {
      const spec = fixture();
      const grant = runGrant(spec, harness);
      expect(grant.rules.some((rule) => ['Read', 'Glob', 'Grep'].includes(rule))).toBe(false);
      expect(grant.rules.some((rule) => /^(Read|Glob|Grep)\(/.test(rule))).toBe(false);
    });
    if (harness.id === 'codex' || harness.id === 'claude-code') continue;
    it(`${harness.id} refuses the review's outside reads and searches after realpath`, () => {
      const spec = fixture();
      const grant = runGrant(spec, harness);
      const decide = (kind: string, path: string) => answerPermission(grant, new Set(), 'session', { sessionId: 'session', options }, {
        kind, rawInput: { path, ...(kind === 'search' ? { pattern: 'source' } : {}) }, locations: [{ path }],
      }, harness.mycoCalls).outcome;
      expect(decide('read', join(spec.repo, 'README.md'))).toEqual({ outcome: 'selected', optionId: 'allow' });
      expect(decide('search', join(spec.repo, 'safe'))).toEqual({ outcome: 'selected', optionId: 'allow' });
      for (const path of [spec.outside, join(spec.home, 'auth.json'), spec.mcpConfigPath, 'repo/../../other-project.txt', 'repo/link/../secret', join(spec.repo, 'escape'), join(spec.repo, 'escape-dir', 'auth.json')]) {
        expect(decide('read', path)).toEqual({ outcome: 'selected', optionId: 'deny' });
      }
      for (const path of [spec.home, spec.scratchDir, join(spec.repo, 'escape-dir')]) {
        expect(decide('search', path)).toEqual({ outcome: 'selected', optionId: 'deny' });
      }
    });
  }
  it('checks all ACP targets, including accumulated locations, and refuses omitted or malformed targets', () => {
    const spec = fixture();
    const grant = runGrant(spec, { sourceGit: 'none', asking: { kind: 'native' } });
    const calls = new ToolCalls();
    calls.saw({ sessionUpdate: 'tool_call', toolCallId: 'read', kind: 'read', rawInput: { file_path: spec.outside } });
    const decide = (call: Record<string, unknown>) => answerPermission(grant, new Set(), 'session', { sessionId: 'session', options }, call).outcome;
    for (const call of [
      { kind: 'read' }, { kind: 'read', rawInput: { path: [] } },
      { kind: 'read', rawInput: { cwd: join(spec.repo, 'safe') } },
      { kind: 'read', locations: [{ path: spec.outside }], rawInput: { path: join(spec.repo, 'README.md') } },
      { kind: 'search', rawInput: { path: join(spec.repo, 'safe'), pattern: `${spec.home}/**` } },
      { kind: 'search', rawInput: { path: join(spec.repo, 'safe'), pattern: '../**' } },
      { kind: 'search', rawInput: { path: join(spec.repo, 'safe'), pattern: spec.outside } },
      { kind: 'search', rawInput: { path: join(spec.repo, 'safe'), pattern: '{../../mcp.json,*.ts}' } },
      calls.merged({ toolCallId: 'read', locations: [{ path: join(spec.repo, 'README.md') }] }),
    ]) expect(decide(call)).toEqual({ outcome: 'selected', optionId: 'deny' });
  });
  it('fails the source turn when its blocking callback cannot answer, before a tool can run', async () => {
    const spec = fixture();
    const bin = stubClaudeSource(['{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'], [{ tool_name: null, tool_input: {} }]);
    const oldPath = process.env.PATH;
    const collect = async () => { for await (const _event of claudeCodeDriver.run(spec, new AbortController().signal)) { /* consume */ } };
    try {
      process.env.PATH = `${bin}:${oldPath}`;
      await collect();
      expect(JSON.parse(readFileSync(join(bin, 'decisions.json'), 'utf8'))).toEqual(['deny']);
    } finally { process.env.PATH = oldPath; }
  });
  it('executes Claude\'s blocking SDK permission callback through the native driver before attempted reads', async () => {
    const spec = fixture();
    const inputs = [
      { tool_name: 'Read', tool_input: { file_path: join(spec.repo, 'README.md') } },
      { tool_name: 'Grep', tool_input: { path: join(spec.repo, 'safe'), pattern: 'source' } },
      { tool_name: 'Glob', tool_input: { path: join(spec.repo, 'safe'), pattern: '*.ts' } },
      ...[spec.outside, spec.mcpConfigPath, 'repo/../../other-project.txt', 'repo/link/../secret', join(spec.repo, 'escape'), join(spec.repo, 'escape-dir', 'auth.json')].map((file_path) => ({ tool_name: 'Read', tool_input: { file_path } })),
      ...[spec.home, spec.scratchDir].map((path) => ({ tool_name: 'Grep', tool_input: { path, pattern: 'source' } })),
      { tool_name: 'Read', tool_input: {} },
      { tool_name: 'Glob', tool_input: { path: join(spec.repo, 'safe'), pattern: `${spec.home}/**` } },
      { tool_name: 'Glob', tool_input: { path: join(spec.repo, 'safe'), pattern: '../**' } },
      { tool_name: 'Glob', tool_input: { path: join(spec.repo, 'safe'), pattern: '{../../mcp.json,*.ts}' } },
      { tool_name: 'Grep', tool_input: { path: join(spec.repo, 'safe'), pattern: 'source', glob: '../**' } },
      { tool_name: 'Bash', tool_input: { command: `cat ${spec.outside}` } },
    ];
    const bin = stubClaudeSource(['{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'], inputs);
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${oldPath}`;
      for await (const _event of claudeCodeDriver.run(spec, new AbortController().signal)) { /* consume native stream */ }
    } finally { process.env.PATH = oldPath; }
    const decisions = JSON.parse(readFileSync(join(bin, 'decisions.json'), 'utf8'));
    const args = readFileSync(join(bin, 'argv.txt'), 'utf8').split('\n');
    expect(decisions).toEqual(['allow', 'allow', 'allow', ...inputs.slice(3).map(() => 'deny')]);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).not.toContain('Read');
    const initialized = JSON.parse(readFileSync(join(bin, 'initialize.json'), 'utf8'));
    expect(initialized.appendSystemPrompt).toBe('Standing source run instructions');
  });
  it('treats refused in-checkout searches as permission failures, while outside refusals remain tool failures', async () => {
    for (const tool of ['Glob', 'Grep']) {
      const spec = fixture();
      const result = (path: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', permission_denials: [{ tool_name: tool, tool_use_id: 'call', tool_input: { path, pattern: 'source' } }] });
      const oldPath = process.env.PATH;
      try {
        process.env.PATH = `${stubClaudeSource([result(join(spec.repo, 'safe'))])}:${oldPath}`;
        const events = [];
        for await (const event of claudeCodeDriver.run(spec, new AbortController().signal)) events.push(event);
        expect(events.at(-1)).toMatchObject({ stop: 'error', code: 'permission_refused', names: [tool] });
        process.env.PATH = `${stubClaudeSource([result(spec.home)])}:${oldPath}`;
        const refused = [];
        for await (const event of claudeCodeDriver.run(spec, new AbortController().signal)) refused.push(event);
        expect(refused.at(-1)).toMatchObject({ stop: 'end_turn' });
      } finally { process.env.PATH = oldPath; }
    }
  });
  it('does not grant a Codex install\'s parent directory containing synthetic host login files', () => {
    const spec = fixture();
    const installed = join(spec.home, 'codex');
    writeFileSync(installed, 'synthetic executable');
    expect(() => runFilesystem(spec, spec.home, installed, null)).toThrow('Unsafe Codex installation directory');
  });
  it('Codex denies undeclared run files and resolves symlink targets under its filesystem profile', () => {
    const spec = fixture();
    const filesystem = runFilesystem(spec, spec.home, null, null);
    const access = (path: string) => Object.entries(filesystem).filter(([root]) => !root.startsWith(':') && (path === root || path.startsWith(root + '/'))).sort(([a], [b]) => b.length - a.length)[0]?.[1] ?? 'deny';
    expect(access(realpathSync(join(spec.repo, 'README.md')))).toBe('read');
    for (const path of [spec.mcpConfigPath, spec.outside, join(spec.home, 'auth.json'), resolve(spec.scratchDir, 'undeclared.txt')]) {
      expect(access(path.endsWith('undeclared.txt') ? path : realpathSync(path))).toBe('deny');
    }
  });
});
