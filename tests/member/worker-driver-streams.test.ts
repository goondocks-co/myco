/**
 * Each driver run against its harness's real stream, and the protocol client
 * run against a real peer.
 *
 * The mapping a driver does is the thing under test, so these feed the driver's
 * own code rather than restating the mapping here: a test that re-implements
 * the translation asserts its own arithmetic and passes while the driver is
 * wrong. The native drivers read line-delimited JSON, so a stub binary that
 * writes recorded bytes exercises the whole path; the protocol driver speaks to
 * a peer over pipes, so a peer written here answers it.
 */
import { objectAt } from '../helpers/json-body.js';
import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeCodeDriver } from '@myco/runner/drivers/claude-code.js';
import { codexDriver } from '@myco/runner/drivers/codex.js';
import { jsonLines } from '@myco/runner/drivers/stream.js';
import { discardRunDir, writeRunDir } from '@myco/runner/mcp-config.js';
import { credentialFile, harnessById } from '@myco/runner/harnesses.js';
import { detectHarnesses } from '@myco/runner/detect.js';
import { runWorker } from '@myco/runner/loop.js';
import { parse } from 'smol-toml';
import { MCP_SERVER_NAME } from '@myco/runner/mcp-config.js';
import { PROJECT_HEADER, PROTOCOL_HEADER } from '@myco/member/constants.js';
import { stubAcpHarness, STUB_DETECTED, STUB_HARNESS } from '../helpers/stub-acp-harness.ts';
import { readFileSync } from 'node:fs';
import { turnOver, type Channel } from '@myco/runner/drivers/acp.js';
import type { RunEvent } from '@myco/runner/events.js';
import { globalFetchDouble } from '../helpers/global-fetch.js';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret' };

/** A stub on PATH that writes these lines and exits with this status, in place of a harness. */
function stubHarness(name: string, lines: readonly string[], exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
  const path = join(dir, name);
  const body = lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join('\n');
  writeFileSync(path, `#!/bin/sh\n${body}\nexit ${exitCode}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return dir;
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function runDir(): { scratchDir: string; mcpConfigPath: string } {
  return writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
}

describe('reading a harness stream into run events', () => {
  it('reads whole lines from a stream that arrives in pieces, and skips what is not an object', async () => {
    async function* chunks(): AsyncIterable<string> {
      yield '{"type":"a"}';
      yield '\nnot json\n{"type":';
      yield '"b"}\n[1,2]\n';
    }
    const seen: unknown[] = [];
    async function* lines(): AsyncIterable<string> {
      let held = '';
      for await (const chunk of chunks()) {
        held += chunk;
        let at = held.indexOf('\n');
        while (at >= 0) { const line = held.slice(0, at).trim(); held = held.slice(at + 1); if (line.length > 0) yield line; at = held.indexOf('\n'); }
      }
      if (held.trim().length > 0) yield held.trim();
    }
    for await (const value of jsonLines(lines())) seen.push(value);
    // A line that is not JSON, and a JSON array, are both passed over.
    expect(seen).toEqual([{ type: 'a' }, { type: 'b' }]);
  });
});

describe('the Claude Code driver', () => {
  const RESULT_SUCCESS = '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","structured_output":null,"total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}';

  it('reads a session, a message and a success whose structured output is null', async () => {
    const dir = stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_9"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}',
      RESULT_SUCCESS,
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.map((e) => e.kind)).toEqual(['started', 'message', 'usage', 'ended']);
    expect(events[0]).toEqual({ kind: 'started', harness: 'claude-code', sessionId: 'sess_9' });
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    // A present-but-null structured output is a success, read by value.
    expect(events[2]).toEqual({ kind: 'usage', inputTokens: 10, outputTokens: 2, cachedTokens: 0, cacheCreationTokens: 0, costUsd: null, estimatedCostUsd: 0.5 });
  });

  it('pins the run\'s permissions on the command line: the asking mode, with the run\'s own server allowed whole', async () => {
    // A `-p` turn answers every permission prompt with a denial. A machine whose
    // own mode asks would run a harness that calls nothing; a machine whose own
    // mode bypasses would hand a queued run every tool it has. Neither reaches
    // the run: what it may call is exactly its own server.
    const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"\nprintf '%s\\n' '${RESULT_SUCCESS}'\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n');
    expect(argv.slice(argv.indexOf('--permission-mode'))).toEqual(['--permission-mode', 'manual', '--permission-prompts', 'none', '--allowedTools', `mcp__${MCP_SERVER_NAME}`, '']);
    expect(argv).toContain('--strict-mcp-config');
  });

  it('allows source history commands with relative, absolute and current-directory paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"\nprintf '%s\\n' '${RESULT_SUCCESS}'\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const run = runDir();
    const repo = join(run.scratchDir, 'repo');
    mkdirSync(repo);
    await collect(claudeCodeDriver.run({ ...run, sourceReadOnly: true, prompt: 'read history', credentialEnv: {} }, new AbortController().signal));
    const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n');
    expect(argv).toContain('Bash(git log:*)');
    expect(argv).toContain('Bash(git -C repo rev-list:*)');
    expect(argv).toContain('Bash(git -C repo grep:*)');
    expect(argv).toContain('Bash(git -C repo blame:*)');
    expect(argv).toContain(`Bash(git -C ${repo} log:*)`);
    expect(argv).toContain(`Bash(git -C ${realpathSync(repo)} log:*)`);
    expect(argv).not.toContain('Bash');
    expect(argv.some((value) => value.startsWith('Bash(') && /(?:push|commit|checkout)/.test(value))).toBe(false);
  });

  it('reads the stream the harness actually writes: content blocks, each tool call and its result, and a denial', async () => {
    const dir = stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_9"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"reading the material"},{"type":"tool_use","id":"tu_1","name":"mcp__myco__myco_run_sessions","input":{"op":"material"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"{\\"session_id\\":\\"s1\\"}"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"mcp__myco__myco_run","input":{"op":"report"}}]}}',
      '{"type":"system","subtype":"permission_denied","tool_name":"mcp__myco__myco_run","tool_use_id":"tu_2"}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","is_error":true,"content":"Claude requested permissions to use mcp__myco__myco_run, but you haven\'t granted it yet."}]}}',
      RESULT_SUCCESS,
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.filter((e) => e.kind === 'message')).toEqual([{ kind: 'message', role: 'assistant', text: 'reading the material' }]);
    // The harness says a refusal twice, on a system line and on the result; it is one refused call.
    expect(events.filter((e) => e.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', name: 'mcp__myco__myco_run_sessions', status: 'started' },
      { kind: 'tool_call', name: 'mcp__myco__myco_run_sessions', status: 'ok' },
      { kind: 'tool_call', name: 'mcp__myco__myco_run', status: 'started' },
      { kind: 'tool_call', name: 'mcp__myco__myco_run', status: 'error' },
    ]);
  });

  it('reads a turn the harness calls a success while it refused the run\'s tools as a failure naming them', async () => {
    const dir = stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_9"}',
      '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[{"tool_name":"mcp__myco__myco_run_sessions","tool_use_id":"tu_1","tool_input":{"op":"material"}},{"tool_name":"mcp__myco__myco_run","tool_use_id":"tu_2","tool_input":{"op":"report"}}]}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'error', detail: 'permission refused for mcp__myco__myco_run_sessions, mcp__myco__myco_run' });
  });

  it('reads an in-band error on a message as the end of the run', async () => {
    const dir = stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_9"}',
      '{"type":"assistant","error":"authentication_failed","message":{"content":""}}',
    ], 1);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'error', detail: 'authentication_failed' });
  });

  it('keeps terminal usage after an in-band failure', async () => {
    const dir = stubHarness('claude', [
      '{"type":"assistant","error":"rate_limit","message":{"content":[]}}',
      RESULT_SUCCESS,
    ], 1);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.find((event) => event.kind === 'usage')).toMatchObject({ estimatedCostUsd: 0.5 });
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'error', detail: 'rate_limit' });
  });

  it('reads a harness that wrote no result at all as a failure, never as a success', async () => {
    const dir = stubHarness('claude', ['{"type":"system","subtype":"init","session_id":"s"}'], 3);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    const last = events.at(-1)!;
    expect(last.kind).toBe('ended');
    if (last.kind === 'ended') { expect(last.stop).toBe('error'); expect(last.detail).toContain('exited 3'); }
  });
});

describe('the Codex driver', () => {
  it('reads an error item as an item and completes the turn anyway', async () => {
    const dir = stubHarness('codex', [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"i0","type":"error","message":"a tool was unavailable"}}',
      '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":28,"output_tokens":5,"cached_input_tokens":14}}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(codexDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    // The error item does not end the turn and does not fail the run.
    expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    expect(events.find((e) => e.kind === 'usage')).toEqual({ kind: 'usage', inputTokens: 28, outputTokens: 5, cachedTokens: 14, costUsd: null });
  });

  it('reads each MCP tool call as a call, with the tool\'s name and how it ended', async () => {
    const dir = stubHarness('codex', [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"i1","type":"mcp_tool_call","server":"myco","tool":"myco_run_sessions","status":"completed"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"mcp_tool_call","server":"myco","tool":"myco_run","status":"failed"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(codexDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.filter((e) => e.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', name: 'myco_run_sessions', status: 'ok' },
      { kind: 'tool_call', name: 'myco_run', status: 'error' },
    ]);
  });

  it('reads a failed turn as a failure', async () => {
    const dir = stubHarness('codex', [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.failed","error":{"message":"the model refused"}}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(codexDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'error', detail: 'the model refused' });
  });

  it('writes the run\'s server into a configuration home of its own, so a host\'s own servers are out of reach', async () => {
    const dir = stubHarness('codex', ['{"type":"turn.completed","usage":{}}']);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const run = runDir();
    await collect(codexDriver.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    const written = readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8');
    expect(written).toContain('[mcp_servers.myco]');
    expect(written).toContain('https://deployment.example/mcp');
    expect(written).toContain(CONNECTION.runToken);
  });

  it('gives source runs a read-only sandbox with no approval prompts', async () => {
    const dir = stubHarness('codex', ['{"type":"turn.completed","usage":{}}']);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const run = runDir();
    await collect(codexDriver.run({ ...run, sourceReadOnly: true, prompt: 'read source', credentialEnv: {} }, new AbortController().signal));
    const config = parse(readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8'));
    expect(config.sandbox_mode).toBe('read-only');
    expect(config.approval_policy).toBe('never');
  });

  /** What a login looks like in the file this harness keeps one in. */
  const LOGIN = '{"tokens":{"access_token":"tok_machine_login"}}';

  /**
   * The machine's own configuration home, at the path the harness manifest
   * declares, holding these files.
   *
   * That path hangs off the home directory, which `tests/setup/sandbox-preload`
   * has already pointed at a throwaway of this process's own, so what is written
   * here is never the developer's own `~/.codex`.
   */
  function machineCodexHome(files: Record<string, string>): { login: string; remove: () => void } {
    const login = credentialFile(harnessById('codex')!)!;
    mkdirSync(dirname(login), { recursive: true, mode: 0o700 });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dirname(login), name), body, { mode: 0o600 });
    return { login, remove: () => { rmSync(dirname(login), { recursive: true, force: true }); } };
  }

  /**
   * A stub `codex` that answers the way the harness does: a turn where the home
   * it was given holds the login, and the model API's own 401 where it does not.
   */
  function stubCodexReadingItsHome(signedInAs = 'tok_machine_login'): string {
    const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
    writeFileSync(join(dir, 'codex'), [
      '#!/bin/sh',
      `if ! grep -q ${JSON.stringify(signedInAs)} "$CODEX_HOME/auth.json" 2>/dev/null; then`,
      `  printf '%s\\n' '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}'`,
      '  exit 0',
      'fi',
      `printf '%s\\n' '{"type":"thread.started","thread_id":"t_login"}'`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
      '',
    ].join('\n'), { mode: 0o755 });
    chmodSync(join(dir, 'codex'), 0o755);
    return dir;
  }

  it('carries the machine\'s login into the run\'s home, so a run on a signed-in machine authenticates', async () => {
    const machine = machineCodexHome({ 'auth.json': LOGIN });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      const events = await collect(codexDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      // A home carrying only the run's server is a run with no login at all: the
      // harness reaches the model's API unauthenticated and fails the turn.
      expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    } finally { machine.remove(); }
  });

  it('leaves the run\'s server as the only MCP server and keeps every other setting the machine has', async () => {
    const machine = machineCodexHome({
      'auth.json': LOGIN,
      'config.toml': [
        'model = "gpt-machine"',
        'notify = [',
        '  "a-command",',
        ']',
        'mcp_servers.rooted.url = "https://rooted.example"',
        '',
        '[features]',
        'web_search = true',
        'instructions = """',
        'a machine writes prose here, and prose says things like',
        '[mcp_servers.playwright]',
        '"""',
        'kept_after_the_string = true',
        '',
        '[mcp_servers.playwright]',
        'command = "npx"',
        '',
        '[mcp_servers.playwright.env]',
        'TOKEN = "operator-secret"',
        '',
        '[mcp_servers.myco]',
        'url = "https://someone-elses.example/mcp"',
        '',
        '[tui]',
        'theme = "dark"',
        '',
      ].join('\n'),
    });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      const run = runDir();
      await collect(codexDriver.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      const merged = readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8');
      // What the operator set is what the run behaves under, whatever shape they
      // wrote it in — a multi-line string that reads like a server declaration
      // among it, which is a value and not a declaration.
      const read = parse(merged) as Record<string, unknown>;
      expect(read.model).toBe('gpt-machine');
      expect(read.features).toEqual({
        web_search: true,
        instructions: 'a machine writes prose here, and prose says things like\n[mcp_servers.playwright]\n',
        kept_after_the_string: true,
      });
      expect(read.tui).toEqual({ theme: 'dark' });
      expect(read.notify).toEqual(['a-command']);
      // A run queued from elsewhere answers no approvals and is bounded by its
      // own directory, whatever the machine allows the person in front of it.
      expect({ approval: read.approval_policy, sandbox: read.sandbox_mode }).toEqual({ approval: 'never', sandbox: 'workspace-write' });
      // The run's server is the only server, whether the machine declared its
      // own under a header or at the root — and no header a machine's server
      // carries reaches the run's directory.
      const servers = objectAt(read, 'mcp_servers');
      expect(Object.keys(servers)).toEqual([MCP_SERVER_NAME]);
      expect(servers[MCP_SERVER_NAME]).toEqual({
        url: 'https://deployment.example/mcp',
        http_headers: { authorization: `Bearer ${CONNECTION.runToken}`, [PROTOCOL_HEADER]: '1', [PROJECT_HEADER]: 'proj_1' },
      });
      expect(merged).not.toContain('operator-secret');
      expect(merged).not.toContain('someone-elses.example');
    } finally { machine.remove(); }
  });

  it('keeps no copy of the login, and the machine\'s login outlives the run\'s home', async () => {
    const machine = machineCodexHome({ 'auth.json': LOGIN });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      const run = runDir();
      await collect(codexDriver.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      const home = join(run.scratchDir, 'codex-home');
      // The login is reachable from the run's home and is not in it: a token the
      // harness refreshes is refreshed in the file the machine signs in with,
      // and there is no second copy of a credential for anything to read.
      expect(lstatSync(join(home, 'auth.json')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(LOGIN);
      const copies = readdirSync(home).filter((entry) => {
        const at = join(home, entry);
        return lstatSync(at).isFile() && readFileSync(at, 'utf8').includes('tok_machine_login');
      });
      expect({ copies, mode: (statSync(home).mode & 0o777).toString(8) }).toEqual({ copies: [], mode: '700' });
      discardRunDir(run.scratchDir);
      expect(existsSync(run.scratchDir)).toBe(false);
      // What the run's directory took with it is the run's, and the machine's
      // login is not: removing a link removes the link.
      expect(readFileSync(machine.login, 'utf8')).toBe(LOGIN);
    } finally { machine.remove(); }
  });

  it('reads where the login is kept from the harness declaration rather than restating the path', async () => {
    const machine = machineCodexHome({ 'auth.json': LOGIN });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      const run = runDir();
      await collect(codexDriver.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      // The manifest is where this path changes, so a driver naming it a second
      // time carries the old one the moment the manifest moves.
      expect(readlinkSync(join(run.scratchDir, 'codex-home', 'auth.json'))).toBe(credentialFile(harnessById('codex')!)!);
    } finally { machine.remove(); }
  });

  it('signs the run in with the Deployment\'s own key where it holds one, rather than with the machine\'s login', async () => {
    const machine = machineCodexHome({ 'auth.json': LOGIN });
    // The harness reads a key from its login file and not from the environment,
    // so a key left in the environment alone signs nothing in.
    process.env.PATH = `${stubCodexReadingItsHome('sk-deployment')}:${process.env.PATH ?? ''}`;
    try {
      const run = runDir();
      const events = await collect(codexDriver.run({ ...run, prompt: 'do it', credentialEnv: { OPENAI_API_KEY: 'sk-deployment' } }, new AbortController().signal));
      expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
      const at = join(run.scratchDir, 'codex-home', 'auth.json');
      expect(lstatSync(at).isSymbolicLink()).toBe(false);
      expect({ login: JSON.parse(readFileSync(at, 'utf8')) as unknown, mode: (statSync(at).mode & 0o777).toString(8) })
        .toEqual({ login: { OPENAI_API_KEY: 'sk-deployment' }, mode: '600' });
    } finally { machine.remove(); }
  });

  it('signs the run in with the machine\'s login where the Deployment holds a key for another harness', async () => {
    const machine = machineCodexHome({ 'auth.json': LOGIN });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      // A credential naming another harness's variable is not a key for this
      // one, and a machine that is signed in still runs.
      const run = runDir();
      const events = await collect(codexDriver.run({ ...run, prompt: 'do it', credentialEnv: { ANTHROPIC_API_KEY: 'sk-not-this-harness' } }, new AbortController().signal));
      expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
      expect(lstatSync(join(run.scratchDir, 'codex-home', 'auth.json')).isSymbolicLink()).toBe(true);
    } finally { machine.remove(); }
  });

  it('reads the machine\'s login where the harness declares it, so detection and a run cannot disagree', () => {
    const machine = machineCodexHome({ 'auth.json': LOGIN });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      expect(detectHarnesses(['codex'])).toEqual([{ id: 'codex', installed: true, authenticated: true }]);
      rmSync(machine.login);
      // The manifest is where this path changes, and a detector naming it a
      // second time answers for a file no run carries.
      expect(detectHarnesses(['codex'])).toEqual([{ id: 'codex', installed: true, authenticated: false }]);
    } finally { machine.remove(); }
  });

  it('builds the run\'s home from nothing, over what a worker that was killed left behind', async () => {
    const machine = machineCodexHome({ 'auth.json': LOGIN });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      const run = runDir();
      const spec = { ...run, prompt: 'do it', credentialEnv: {} };
      await collect(codexDriver.run(spec, new AbortController().signal));
      // The same run is claimed again under the same id, and what the last
      // attempt left in its directory is not what the next one reads.
      const events = await collect(codexDriver.run(spec, new AbortController().signal));
      expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    } finally { machine.remove(); }
  });
});

/** A peer that answers the protocol, in place of a harness binary. */
function peer(answer: (method: string, id: number) => string | null): { channel: Channel; close: () => void; asked: string[] } {
  const asked: string[] = [];
  let read: ((line: string) => void) | null = null;
  let closed: (() => void) | null = null;
  const channel: Channel = {
    write: (line) => {
      const message = JSON.parse(line) as { id: number; method: string };
      asked.push(message.method);
      const reply = answer(message.method, message.id);
      if (reply !== null) queueMicrotask(() => read?.(reply));
    },
    onLine: (fn) => { read = fn; },
    onClose: (fn) => { closed = fn; },
  };
  return { channel, close: () => closed?.(), asked };
}

describe('the agent-protocol driver', () => {
  it('opens a session naming the run\'s server, prompts once, and answers the turn\'s stop reason', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => {
      if (method === 'initialize') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } })}\n`;
      if (method === 'session/new') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sess_acp' } })}\n`;
      if (method === 'session/prompt') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`;
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`;
    });
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => ''));
    expect(events[0]).toEqual({ kind: 'started', harness: 'opencode', sessionId: 'sess_acp' });
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    expect(p.asked).toEqual(['initialize', 'session/new', 'session/prompt', 'session/close']);
  });

  it('answers a stop reason the protocol does not name as a failure', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => `${JSON.stringify({ jsonrpc: '2.0', id, result: method === 'session/prompt' ? { stopReason: 'something_else' } : { sessionId: 's' } })}\n`);
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => 'stderr said this'));
    const last = events.at(-1)!;
    expect(last.kind).toBe('ended');
    if (last.kind === 'ended') { expect(last.stop).toBe('error'); expect(last.detail).toContain('stderr said this'); }
  });

  it('ends the run when the harness dies mid-turn rather than waiting on an answer that cannot come', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => {
      // The peer answers the handshake and then goes away without answering the prompt.
      if (method === 'session/prompt') { queueMicrotask(() => { p.close(); }); return null; }
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 's' } })}\n`;
    });
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => 'it exited 137'));
    const last = events.at(-1)!;
    expect(last.kind).toBe('ended');
    if (last.kind === 'ended') { expect(last.stop).toBe('error'); expect(last.detail).toContain('closed the connection'); }
  });
});

describe('the run credential a driver launches under', () => {
  it('reaches the run\'s own files and never a command line or a stream a log would carry', async () => {
    // A stub that writes back everything a process list and a log would show,
    // so the assertion is over what the launch actually did rather than over
    // what the driver meant to do.
    const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
    const seen = join(dir, 'seen.txt');
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(seen)}\nenv >> ${JSON.stringify(seen)}\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'\n`, { mode: 0o755 });
    chmodSync(join(dir, 'claude'), 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;

    const run = runDir();
    const events = await collect(claudeCodeDriver.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });

    // The token is in the run's own configuration and in nothing the harness
    // was handed on its command line or in its environment.
    expect(readFileSync(run.mcpConfigPath, 'utf8')).toContain(CONNECTION.runToken);
    const handed = readFileSync(seen, 'utf8');
    expect(handed).not.toContain(CONNECTION.runToken);
    expect(handed).toContain(run.mcpConfigPath);
  });
});

/** A stub `claude` that writes a result after a delay, so a run lasts long enough to be renewed. */
function slowHarness(ms: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nsleep ${(ms / 1000).toFixed(2)}\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'\n`, { mode: 0o755 });
  chmodSync(join(dir, 'claude'), 0o755);
  return dir;
}

describe('the cadence a worker keeps', () => {
  // A fallback far above the answered wait but well under the test's own bound,
  // so ignoring the answer fails on elapsed time with a message rather than on
  // a timeout with none.
  const FALLBACK_MS = 3_000;
  const ANSWERED_POLL_MS = 20;

  it('waits what the Deployment answered, not the fallback it was constructed with', async () => {
    const asked: string[] = [];
    const stopping = new AbortController();
    let polls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      asked.push(new URL(url).pathname);
      if (url.endsWith('/worker/claim')) {
        polls += 1;
        if (polls >= 3) stopping.abort();
        return new Response(JSON.stringify({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: ANSWERED_POLL_MS }), { status: 200 });
      }
      return new Response(JSON.stringify({ persisted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const started = Date.now();
    await runWorker({
      serverUrl: 'https://deployment.example', token: 'tok',
      runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
      pollIdleMs: FALLBACK_MS, log: () => {}, fetchImpl, signal: stopping.signal,
    });
    const elapsed = Date.now() - started;
    expect(asked.filter((p) => p === '/worker/claim').length).toBe(3);
    // Two waits at the answered cadence, against two at the fallback.
    expect({ elapsed: elapsed < FALLBACK_MS, polls: 3 }).toEqual({ elapsed: true, polls: 3 });
  }, 15_000);

  it('renews at the cadence the claim answered, so a run is held while it is driven', async () => {
    const HEARTBEAT_MS = 60;
    const RUN_MS = 400;
    process.env.PATH = `${slowHarness(RUN_MS)}:${process.env.PATH ?? ''}`;
    const stopping = new AbortController();
    let renewals = 0;
    // Held behind a property: the body lands inside the fetch double, and a bare
    // binding reads as its initializer at every site after it.
    const end: { body: Record<string, unknown> | null } = { body: null };
    let claims = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.endsWith('/worker/claim')) {
        claims += 1;
        return new Response(JSON.stringify({
          persisted: true, claimed: true, heartbeatMs: HEARTBEAT_MS,
          run: {
            projectId: 'proj_1', id: 'run_1', task: 'title-summary', instruction: 'do it',
            harness: 'claude-code', runToken: 'tok_run', credentialEnv: {}, timeoutSeconds: 300,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/worker/lease')) { renewals += 1; return new Response(JSON.stringify({ persisted: true, held: true, expiresAt: 0 }), { status: 200 }); }
      if (url.endsWith('/worker/end')) { end.body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ persisted: true, ended: true }), { status: 200 }); }
      return new Response(JSON.stringify({ persisted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await runWorker({
      serverUrl: 'https://deployment.example', token: 'tok',
      runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
      once: true, pollIdleMs: FALLBACK_MS, log: () => {}, fetchImpl, signal: stopping.signal,
    });

    // A run driven for RUN_MS is renewed at the answered cadence. A worker
    // keeping a cadence of its own renews once or not at all across that span.
    expect({ claims, renewed: renewals >= 2, ended: end.body }).toEqual({
      claims: 1, renewed: true,
      ended: { projectId: 'proj_1', runId: 'run_1', status: 'completed', error: null },
    });
  }, 15_000);
});

describe('the budget a run is held to', () => {
  for (const leaseHeld of [true, false]) {
    it(leaseHeld ? 'reports an overrun while it still holds the lease' : 'sends no outcome when a lost lease is followed by an overrun', async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'myco-budget-'));
      const release = join(scratch, 'release');
      const pidFile = join(scratch, 'peer.pid');
      const stopping = new AbortController();
      const lines: string[] = [];
      const outcomes: unknown[] = [];
      const previousPath = process.env.PATH;
      expect(stubAcpHarness({ holdUntil: release, ignoreTermination: true, pidFile })).toEqual(STUB_DETECTED);
      const fetchImpl = globalFetchDouble(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/worker/claim')) return Response.json({
          persisted: true, claimed: true, heartbeatMs: 100,
          run: {
            projectId: 'proj_1', id: 'run_overrun', task: 'title-summary', instruction: 'do it',
            harness: STUB_HARNESS, runToken: 'tok_run', credentialEnv: {}, timeoutSeconds: 0,
          },
        });
        // Lease loss begins only after the child receives its prompt.
        if (url.endsWith('/worker/lease')) return Response.json({ persisted: true, held: leaseHeld || !existsSync(pidFile) });
        if (url.endsWith('/worker/end')) {
          outcomes.push(JSON.parse(String(init?.body)));
          return Response.json({ persisted: true, ended: leaseHeld });
        }
        throw new Error(`Unexpected worker request: ${url}`);
      });
      const bound = setTimeout(() => { writeFileSync(release, ''); stopping.abort(); }, 10_000);
      try {
        const outcome = await runWorker({
          serverUrl: 'https://deployment.example', token: 'tok', runRoot: join(scratch, 'runs'),
          only: [STUB_HARNESS], once: true, pollIdleMs: 100, log: (line) => { lines.push(line); }, fetchImpl, signal: stopping.signal,
        });
        expect(outcome).toEqual({ driven: 1, refused: null });
        expect(lines.some((line) => line.includes('lease lost'))).toBe(!leaseHeld);
        expect(lines.some((line) => line.includes('outlived its budget'))).toBe(true);
        expect(outcomes).toEqual(leaseHeld
          ? [{ projectId: 'proj_1', runId: 'run_overrun', status: 'failed', error: 'the run outlived its budget of 0s' }]
          : []);
      } finally {
        clearTimeout(bound);
        writeFileSync(release, '');
        stopping.abort();
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, 'utf8'));
          try { process.kill(pid, 'SIGKILL'); } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
          }
        }
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 15_000);
  }
});
