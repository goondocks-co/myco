import { profileWorkerServer } from '../helpers/profile-worker-server.js';
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
import { activeDeveloperDir, codexDriver, codexDriverWith, developerDirVerdict, SYSTEM_DEVELOPER_DIR_PROBE, RUN_FEATURES_OFF, RUN_PERMISSIONS, runFilesystem, sourceGitEnvironment, type DeveloperDirProbe } from '@myco/runner/drivers/codex.js';
import { jsonLines } from '@myco/runner/drivers/stream.js';
import { confinedGitEnv } from '@myco/runner/drivers/source-git.js';
import { resolveMycoHome } from '@myco/paths/home.js';
import { RUN_REPOSITORY_DIGESTS_FILE, RUN_REPOSITORY_DIR } from '@goondocks/myco-shared/repository';
import { discardRunDir, writeRunDir } from '@myco/runner/mcp-config.js';
import { credentialFile, harnessById } from '@myco/runner/harnesses.js';
import { detectHarnesses, WITHHELD_REASON } from '@myco/runner/detect.js';
import { driverFor } from '@myco/runner/drivers/registry.js';
import { run as runWorkerCli } from '@myco/cli/worker.js';
import { runWorker } from '@myco/runner/loop.js';
import { parse } from 'smol-toml';
import { MCP_SERVER_NAME } from '@myco/runner/mcp-config.js';
import { PROJECT_HEADER, PROTOCOL_HEADER } from '@myco/member/constants.js';
import { stubAcpHarness, STUB_DETECTED, STUB_HARNESS } from '../helpers/stub-acp-harness.ts';
import { stubProfileHarness, PROFILE_STUB_DETECTED, PROFILE_STUB_HARNESS, STUB_PROFILE } from '../helpers/stub-profile-harness.ts';
import { readFileSync } from 'node:fs';
import { runAsking, turnOver, type Channel } from '@myco/runner/drivers/acp.js';
import { listRunTools, type RunTools } from '@myco/runner/drivers/run-tools.js';
import { runGrant } from '@myco/runner/drivers/grant.js';
import { failedCallsNote, type RunEvent } from '@myco/runner/events.js';
import { EFFORT_UNAPPLIED, PROFILE_UNAPPLIED, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { MECHANISM_WORDS, RETIRED_VOCABULARY } from '../helpers/reader-vocabulary.ts';
import { globalFetchDouble } from '../helpers/global-fetch.js';
import { listingOnly, withRunMcp } from '../helpers/run-mcp-fetch.ts';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret' };

/** A stub on PATH that writes these lines and exits with this status, in place of a harness. */
function stubHarness(name: string, lines: readonly string[], exitCode = 0): string {
  const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-stub-')));
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
  return writeRunDir(removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-run-'))), 'run_1', CONNECTION);
}

/** Where a Mac's command line tools are, which is the developer directory `FAKE_MAC` selects. */
const TOOLS = '/Library/Developer/CommandLineTools';

/** The user a fake Mac's worker runs as. */
const WORKER_UID = 501;

/** One path a fake Mac holds: who owns it, its permission bits, and what it is. */
interface FakePath { uid: number; mode: number; kind: 'dir' | 'file' }

/**
 * A Mac as `activeDeveloperDir` reads one, on any system: `selected` is what
 * `xcode-select -p` names, `paths` what is on disk, `links` where a path
 * physically is. Paths it does not hold are the machine's own, so a real run
 * directory resolves as it does on disk.
 */
function fakeMac(options: { selected?: string | null; paths?: Record<string, FakePath>; links?: Record<string, string>; home?: string; platform?: NodeJS.Platform; uid?: number; closed?: string[] } = {}): DeveloperDirProbe {
  const paths: Record<string, FakePath> = options.paths ?? {
    [TOOLS]: { uid: 0, mode: 0o40755, kind: 'dir' },
    [join(TOOLS, 'usr', 'bin', 'git')]: { uid: 0, mode: 0o100755, kind: 'file' },
  };
  const links = options.links ?? {};
  const home = options.home ?? '/Users/member';
  return {
    platform: options.platform ?? 'darwin',
    select: () => (options.selected === undefined ? TOOLS : options.selected),
    stat: (path) => {
      const found = paths[path];
      return found === undefined ? null : { uid: found.uid, mode: found.mode, directory: found.kind === 'dir', file: found.kind === 'file' };
    },
    realpath: (path) => {
      if (links[path] !== undefined) return links[path]!;
      if (paths[path] !== undefined || path === home) return path;
      return realpathSync(path);
    },
    home,
    uid: options.uid ?? WORKER_UID,
    closed: options.closed ?? [join(home, '.codex'), MYCO_HOME_ELSEWHERE],
  };
}

/** A Myco home outside the user's home, where a fake Mac's worker keeps its own. */
const MYCO_HOME_ELSEWHERE = '/opt/myco/home';

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
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-stub-')));
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"\nprintf '%s\\n' '${RESULT_SUCCESS}'\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').split('\n');
    expect(argv.slice(argv.indexOf('--permission-mode'))).toEqual(['--permission-mode', 'manual', '--permission-prompts', 'none', '--allowedTools', `mcp__${MCP_SERVER_NAME}`, '']);
    expect(argv).toContain('--strict-mcp-config');
  });

  it('passes the claimed model and effort to Claude and protects injected OAuth from inherited API credentials', async () => {
    const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-stub-')));
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"\nenv > "$(dirname "$0")/env.txt"\nprintf '%s\\n' '${RESULT_SUCCESS}'\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    const operatorOverrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_CLIENT_DATA_URL', 'ANTHROPIC_SMALL_FAST_MODEL'];
    const previous = Object.fromEntries(operatorOverrides.map((key) => [key, process.env[key]]));
    process.env.PATH = `${dir}:${previousPath ?? ''}`;
    process.env.ANTHROPIC_API_KEY = 'inherited-api-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-auth-token';
    process.env.ANTHROPIC_MODEL = 'opus';
    for (const key of operatorOverrides.slice(3)) process.env[key] = 'operator-override';
    try {
      await collect(claudeCodeDriver.run({
        ...runDir(), prompt: 'do it', credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'injected-oauth' },
        profile: { tier: 'low', model: 'haiku', effort: 'low', sources: { tier: 'task', model: 'default' } },
      }, new AbortController().signal));
      const argv = readFileSync(join(dir, 'argv.txt'), 'utf8').trim().split('\n');
      expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 4)).toEqual(['--model', 'haiku', '--effort', 'low']);
      expect(argv.slice(argv.indexOf('--setting-sources'), argv.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'project,local']);
      const env = readFileSync(join(dir, 'env.txt'), 'utf8');
      expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=injected-oauth');
      expect(env).not.toContain('ANTHROPIC_API_KEY=');
      expect(env).not.toContain('ANTHROPIC_AUTH_TOKEN=');
      expect(env).not.toContain('ANTHROPIC_MODEL=');
      for (const key of operatorOverrides.slice(3)) expect(env).not.toContain(`${key}=`);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
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
    expect(argv).not.toContain('Bash(git -C repo grep:*)');
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

  it('names a call that failed with what its result said, so a turn that ended right after reads as cut short by that call', async () => {
    const said = 'MCP error -32001: Session capture is incomplete or has errors; retry after its transcripts are fully processed.';
    const dir = stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_9"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"mcp__myco__myco_run_sessions","input":{"op":"material"}}]}}',
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":true,"content":${JSON.stringify(said)}}]}}`,
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"mcp__myco__myco_run_sessions","input":{"op":"material"}}]}}',
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","is_error":true,"content":[{"type":"text","text":${JSON.stringify(`${said}\nmore detail`)}}]}]}}`,
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_3","name":"Bash","input":{"command":"git -C repo log"}}]}}',
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_3","is_error":true,"content":${JSON.stringify('Exit code 1\ngit: cannot change to repo')}}]}}`,
      RESULT_SUCCESS,
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.filter((e) => e.kind === 'tool_call' && e.status === 'error')).toEqual([
      { kind: 'tool_call', name: 'mcp__myco__myco_run_sessions', status: 'error', detail: said },
      { kind: 'tool_call', name: 'mcp__myco__myco_run_sessions', status: 'error', detail: said },
      { kind: 'tool_call', name: 'Bash', status: 'error', detail: 'git: cannot change to repo (exit code 1)' },
    ]);
    expect(failedCallsNote(events)).toBe(`3 calls failed or were refused: mcp__myco__myco_run_sessions (${said}) ×2; Bash (git: cannot change to repo (exit code 1)); the turn ended right after the last of them`);
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

  it('reads a refusal of a tool outside the run\'s grant as that call failing, and the turn\'s own end as the run\'s', async () => {
    // The harness keeping a run to its tools is the grant working: the run did
    // its work over its own server, and a refused shell call is one failed call.
    const dir = stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_9"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"tu_1"}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":true,"content":"Claude requested permissions to use Bash, but you haven\'t granted it yet."}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"Read","input":{"file_path":"/etc/hosts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_3","name":"mcp__myco__myco_run","input":{"op":"report"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_3","content":"{\\"ok\\":true}"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[{"tool_name":"Bash","tool_use_id":"tu_1","tool_input":{"command":"ls"}},{"tool_name":"Read","tool_use_id":"tu_2","tool_input":{"file_path":"/etc/hosts"}}]}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    // Each refused call is one failed call, whichever line said so first.
    expect(events.filter((e) => e.kind === 'tool_call' && e.status === 'error')).toEqual([
      { kind: 'tool_call', name: 'Bash', status: 'error' },
      { kind: 'tool_call', name: 'Read', status: 'error' },
    ]);
  });

  it('reads a refused history command in a source run as outside its grant, and a refused file read as the run kept from its work', async () => {
    const run = runDir();
    mkdirSync(join(run.scratchDir, 'repo'));
    const result = (denials: string): string => `{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[${denials}]}`;
    const shell = '{"tool_name":"Bash","tool_use_id":"tu_1","tool_input":{"command":"git log | head"}}';
    process.env.PATH = `${stubHarness('claude', [result(shell)])}:${process.env.PATH ?? ''}`;
    const scoped = await collect(claudeCodeDriver.run({ ...run, sourceReadOnly: true, prompt: 'read history', credentialEnv: {} }, new AbortController().signal));
    expect(scoped.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });

    process.env.PATH = `${stubHarness('claude', [result(`${shell},{"tool_name":"Read","tool_use_id":"tu_2","tool_input":{"file_path":"repo/README.md"}}`)])}:${process.env.PATH ?? ''}`;
    const granted = await collect(claudeCodeDriver.run({ ...run, sourceReadOnly: true, prompt: 'read history', credentialEnv: {} }, new AbortController().signal));
    expect(granted.at(-1)).toEqual({ kind: 'ended', stop: 'error', detail: 'permission refused for Read' });
  });

  it('reads a refusal of a tool that only shares the run server\'s prefix as outside the grant', async () => {
    const dir = stubHarness('claude', [
      '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[{"tool_name":"mcp__mycox__foo","tool_use_id":"tu_1","tool_input":{}}]}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    expect(events.filter((e) => e.kind === 'tool_call')).toEqual([{ kind: 'tool_call', name: 'mcp__mycox__foo', status: 'error' }]);
  });

  it('reports a refused call once when the harness says so on its result and on the turn\'s result, with no system line', async () => {
    const dir = stubHarness('claude', [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":true,"content":"Claude requested permissions to use Bash, but you haven\'t granted it yet."}]}}',
      '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[{"tool_name":"Bash","tool_use_id":"tu_1","tool_input":{"command":"ls"}}]}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.filter((e) => e.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', name: 'Bash', status: 'started' },
      { kind: 'tool_call', name: 'Bash', status: 'error', detail: 'Claude requested permissions to use Bash, but you haven\'t granted it yet.' },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });

  it('reports every call result that names no call, since none can be matched to another', async () => {
    const dir = stubHarness('claude', [
      '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"first"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"second"}]}}',
      RESULT_SUCCESS,
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.filter((e) => e.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', name: 'tool', status: 'error', detail: 'first' },
      { kind: 'tool_call', name: 'tool', status: 'error', detail: 'second' },
    ]);
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

describe('the developer directory a Codex source run may read (#1475)', () => {
  // Outside the home, so each of the two ancestor checks is the only one a case meets.
  const RUN = '/Volumes/work/runs/run_1';
  const ROOT_DIR: FakePath = { uid: 0, mode: 0o40755, kind: 'dir' };
  const ROOT_FILE: FakePath = { uid: 0, mode: 0o100755, kind: 'file' };
  /** A Mac whose selected developer directory is `dir`, holding `usr/bin/git` as `git`. */
  const selecting = (dir: string, owner: FakePath = ROOT_DIR, git: FakePath | null = ROOT_FILE, extra: Partial<Parameters<typeof fakeMac>[0]> = {}) =>
    fakeMac({ selected: dir, paths: { [RUN]: { uid: 501, mode: 0o40700, kind: 'dir' }, [dir]: owner, ...(git === null ? {} : { [join(dir, 'usr', 'bin', 'git')]: git }) }, ...extra });

  it('is the selected directory where it is a developer directory owned by root that nobody else can write', () => {
    expect(activeDeveloperDir(RUN, selecting(TOOLS))).toBe(TOOLS);
  });

  it('is an Xcode the worker\'s own user installed, a `.xip` or a disk image, owned by that user and held to every other check (#1481)', () => {
    const XCODE = '/Applications/Xcode.app/Contents/Developer';
    expect(activeDeveloperDir(RUN, selecting(XCODE, { uid: WORKER_UID, mode: 0o40755, kind: 'dir' }))).toBe(XCODE);
    expect(activeDeveloperDir(RUN, selecting(XCODE, { uid: WORKER_UID, mode: 0o40775, kind: 'dir' }))).toBeNull();
    expect(activeDeveloperDir(RUN, selecting('/Users/member', { uid: WORKER_UID, mode: 0o40755, kind: 'dir' }))).toBeNull();
    expect(activeDeveloperDir(RUN, selecting(XCODE, { uid: WORKER_UID, mode: 0o40755, kind: 'dir' }, null))).toBeNull();
  });

  it('is judged at the path the directory physically has, since that is the path the sandbox grants', () => {
    // `xcode-select` may name a link; the grant and the checks are the target's.
    expect(activeDeveloperDir(RUN, selecting(TOOLS, ROOT_DIR, ROOT_FILE, { selected: '/var/db/xcode_select_link', links: { '/var/db/xcode_select_link': TOOLS } }))).toBe(TOOLS);
    expect(activeDeveloperDir(RUN, selecting('/Users', ROOT_DIR, ROOT_FILE, { selected: '/var/db/xcode_select_link', links: { '/var/db/xcode_select_link': '/Users' } }))).toBeNull();
  });

  it('is nothing wherever a check fails', () => {
    const refused: Record<string, DeveloperDirProbe> = {
      'another system': selecting(TOOLS, ROOT_DIR, ROOT_FILE, { platform: 'linux' }),
      'none selected': selecting(TOOLS, ROOT_DIR, ROOT_FILE, { selected: null }),
      'a selection that is not there': fakeMac({ selected: '/nowhere/at/all', links: {} }),
      'owned by another user': selecting(TOOLS, { uid: 502, mode: 0o40755, kind: 'dir' }),
      'a directory above the home the home links to': selecting('/Users', ROOT_DIR, ROOT_FILE, { home: '/var/home-link', links: { '/var/home-link': '/Users/member' } }),
      'writable by its group': selecting(TOOLS, { uid: 0, mode: 0o40775, kind: 'dir' }),
      'writable by everyone': selecting(TOOLS, { uid: 0, mode: 0o41777, kind: 'dir' }),
      'a file rather than a directory': selecting(TOOLS, { uid: 0, mode: 0o100755, kind: 'file' }),
      'the root of the filesystem': selecting('/'),
      'the home directory itself': selecting('/Users/member'),
      'a directory above the home directory': selecting('/Users'),
      'the run\'s own directory': selecting(RUN),
      'a directory above the run\'s own directory': selecting('/Volumes/work/runs'),
      'no git in it': selecting(TOOLS, ROOT_DIR, null),
      'a git that is not a file': selecting(TOOLS, ROOT_DIR, { uid: 0, mode: 0o40755, kind: 'dir' }),
      // A user's own directory can sit in the home: the harness's login directory, with a `usr/bin/git` placed in it.
      'the harness login\'s directory': selecting('/Users/member/.codex', { uid: WORKER_UID, mode: 0o40700, kind: 'dir' }),
      'a directory holding the Myco home': selecting('/opt/myco', { uid: WORKER_UID, mode: 0o40755, kind: 'dir' }),
      'the Myco home a link names': selecting('/opt/myco-link', { uid: WORKER_UID, mode: 0o40755, kind: 'dir' }, ROOT_FILE, { closed: ['/Users/member/.codex', '/var/myco-link'], links: { '/var/myco-link': '/opt/myco-link/home' } }),
    };
    const granted = Object.fromEntries(Object.entries(refused).map(([why, probe]) => [why, activeDeveloperDir(RUN, probe)]));
    expect(granted).toEqual(Object.fromEntries(Object.keys(refused).map((why) => [why, null])));
    // Each names the check it failed, except where no directory was there to check.
    const named = Object.fromEntries(Object.entries(refused).map(([why, probe]) => {
      const verdict = developerDirVerdict(RUN, probe);
      return [why, verdict.dir === null ? verdict.refused : 'granted'];
    }));
    expect(named).toEqual({
      'another system': null,
      'none selected': null,
      'a selection that is not there': '/nowhere/at/all, or the home or run directory, has no physical path',
      'owned by another user': `${TOOLS} is owned by neither root nor the user this worker runs as`,
      'a directory above the home the home links to': '/Users is the filesystem root or holds the home or the run\'s directory',
      'writable by its group': `${TOOLS} is writable by its group or others`,
      'writable by everyone': `${TOOLS} is writable by its group or others`,
      'a file rather than a directory': `${TOOLS} is not a directory`,
      'the root of the filesystem': '/ is the filesystem root or holds the home or the run\'s directory',
      'the home directory itself': '/Users/member is the filesystem root or holds the home or the run\'s directory',
      'a directory above the home directory': '/Users is the filesystem root or holds the home or the run\'s directory',
      'the run\'s own directory': `${RUN} is the filesystem root or holds the home or the run's directory`,
      'a directory above the run\'s own directory': '/Volumes/work/runs is the filesystem root or holds the home or the run\'s directory',
      'no git in it': `${TOOLS} holds no usr/bin/git`,
      'a git that is not a file': `${TOOLS} holds no usr/bin/git`,
      'the harness login\'s directory': '/Users/member/.codex is or holds the harness login\'s directory or the Myco home',
      'a directory holding the Myco home': '/opt/myco is or holds the harness login\'s directory or the Myco home',
      'the Myco home a link names': '/opt/myco-link is or holds the harness login\'s directory or the Myco home',
    });
  });

  it('puts the developer directory\'s own `git` first on a source run\'s PATH, ahead of the xcrun shim (#1481)', () => {
    expect(sourceGitEnvironment(TOOLS, '/usr/bin:/bin')).toEqual({ ...confinedGitEnv(), DEVELOPER_DIR: TOOLS, PATH: `${TOOLS}/usr/bin:/usr/bin:/bin` });
    expect(sourceGitEnvironment(null, '/usr/bin:/bin')).toEqual(confinedGitEnv());
  });

  it('runs a source run\'s Git under the confinement the other harnesses\' `git` sets, so it reads no file of the user\'s the sandbox hides', () => {
    const env = sourceGitEnvironment(TOOLS, '/usr/bin:/bin');
    const config = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, at) => [env[`GIT_CONFIG_KEY_${at}`], env[`GIT_CONFIG_VALUE_${at}`]]));
    expect({ global: env.GIT_CONFIG_GLOBAL, system: env.GIT_CONFIG_NOSYSTEM, excludes: config['core.excludesFile'], attributes: config['core.attributesFile'] })
      .toEqual({ global: '/dev/null', system: '1', excludes: '/dev/null', attributes: '/dev/null' });
  });

  it('is read by a source run alone, whatever directory is handed to the profile', () => {
    const run = runDir();
    const home = mkdtempSync(join(tmpdir(), 'myco-codex-home-'));
    const spec = { ...run, prompt: 'p', credentialEnv: {} };
    const access = (filesystem: Record<string, string>): string | null => filesystem[TOOLS] ?? null;
    expect({
      source: access(runFilesystem({ ...spec, sourceReadOnly: true }, home, null, TOOLS)),
      other: access(runFilesystem(spec, home, null, TOOLS)),
      none: Object.keys(runFilesystem({ ...spec, sourceReadOnly: true }, home, null, null)).filter((path) => path.startsWith('/Library')),
    }).toEqual({ source: 'read', other: null, none: [] });
  });

  it('on this machine, closes the Codex login\'s directory and the Myco home the worker runs with (#1481)', () => {
    const login = credentialFile(harnessById('codex')!);
    expect(SYSTEM_DEVELOPER_DIR_PROBE.closed).toEqual([...(login === null ? [] : [dirname(login)]), resolveMycoHome()]);
    expect(SYSTEM_DEVELOPER_DIR_PROBE.closed.length).toBe(2);
  });

  it('on this machine, is nothing or a directory every check passes', () => {
    const run = runDir();
    const dir = activeDeveloperDir(run.scratchDir);
    if (process.platform !== 'darwin') { expect(dir).toBeNull(); return; }
    if (dir === null) return;
    const found = statSync(dir);
    expect({ owner: found.uid === 0 || found.uid === process.getuid?.(), writable: found.mode & 0o022, git: statSync(join(dir, 'usr', 'bin', 'git')).isFile() }).toEqual({ owner: true, writable: 0, git: true });
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
    // The error item does not end the turn, does not fail the run, and is not
    // a call: a note of the calls that failed would otherwise blame it.
    expect(events.filter((e) => e.kind === 'tool_call')).toEqual([]);
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

  it('pins the claimed Codex model and effort in its generated run configuration', async () => {
    const dir = stubHarness('codex', ['{"type":"turn.completed","usage":{}}']);
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath ?? ''}`;
    try {
      const run = runDir();
      await collect(codexDriver.run({
        ...run, prompt: 'do it', credentialEnv: {},
        profile: { tier: 'high', model: 'gpt-6.1', effort: 'high', sources: { tier: 'task-override', model: 'configured' } },
      }, new AbortController().signal));
      const config = parse(readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8')) as Record<string, unknown>;
      expect({ model: config.model, effort: config.model_reasoning_effort }).toEqual({ model: 'gpt-6.1', effort: 'high' });
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });

  it('holds a run to a sandbox of its own, since the harness never asks and the run\'s grant never reaches it', async () => {
    const dir = stubHarness('codex', ['{"type":"turn.completed","usage":{}}']);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    for (const sourceReadOnly of [true, false]) {
      const run = runDir();
      await collect(codexDriverWith(fakeMac()).run({ ...run, sourceReadOnly, prompt: 'read source', credentialEnv: {} }, new AbortController().signal));
      const home = join(run.scratchDir, 'codex-home');
      const config = parse(readFileSync(join(home, 'config.toml'), 'utf8')) as Record<string, unknown>;
      // Reads reach the system's minimal set and the run's own directory, and
      // nothing else: not the temporary directories, not the run's
      // configuration home or MCP configuration, which hold its credentials.
      // Writes reach nothing on a source run, and only the run's directory
      // otherwise. A sandbox judges a file by its physical path.
      expect({
        approval: config.approval_policy,
        profile: config.default_permissions,
        permissions: config.permissions,
        sandbox: config.sandbox_mode,
        search: config.web_search,
        loginShell: config.allow_login_shell,
      }).toEqual({
        approval: 'never',
        profile: RUN_PERMISSIONS,
        permissions: {
          [RUN_PERMISSIONS]: {
            filesystem: {
              ':minimal': 'read',
              ':slash_tmp': 'deny',
              ':tmpdir': 'deny',
              // The harness runs a helper of its own program in the sandbox, by the path PATH gave it.
              [dir]: 'read',
              [realpathSync(dir)]: 'read',
              // Only a source run runs `git`, so only a source run reads the developer directory.
              ...(sourceReadOnly ? { [TOOLS]: 'read' } : {}),
              [realpathSync(run.scratchDir)]: sourceReadOnly ? 'read' : 'write',
              [realpathSync(home)]: 'deny',
              [realpathSync(run.mcpConfigPath)]: 'deny',
            },
          },
        },
        sandbox: undefined,
        search: 'disabled',
        // A login shell reads the system's profile, which puts `/usr/bin` back ahead of the developer directory's git.
        loginShell: sourceReadOnly ? false : undefined,
      });
    }
  });

  it('lets a source run read the digest listing and the checkout, and run Git on them, under the profile it is given (#1462)', async () => {
    const dir = stubHarness('codex', ['{"type":"turn.completed","usage":{}}']);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const run = runDir();
    // What the worker stages for a map run: the checkout, and the listing beside it.
    mkdirSync(join(run.scratchDir, RUN_REPOSITORY_DIR, 'src'), { recursive: true });
    writeFileSync(join(run.scratchDir, RUN_REPOSITORY_DIR, 'src', 'a.ts'), 'x');
    writeFileSync(join(run.scratchDir, RUN_REPOSITORY_DIGESTS_FILE), 'ab  src/a.ts\n');
    await collect(codexDriverWith(fakeMac()).run({ ...run, sourceReadOnly: true, prompt: 'map the source', credentialEnv: {} }, new AbortController().signal));
    const config = parse(readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8')) as Record<string, unknown>;
    const filesystem = objectAt(objectAt(objectAt(config, 'permissions'), RUN_PERMISSIONS), 'filesystem') as Record<string, string>;
    // The sandbox takes the most specific entry that holds a path.
    const access = (path: string) => Object.entries(filesystem).filter(([root]) => !root.startsWith(':') && (path === root || path.startsWith(`${root}/`)))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1];
    const scratch = realpathSync(run.scratchDir);
    expect({
      listing: access(join(scratch, RUN_REPOSITORY_DIGESTS_FILE)),
      source: access(join(scratch, RUN_REPOSITORY_DIR, 'src', 'a.ts')),
    }).toEqual({ listing: 'read', source: 'read' });
    // Git runs from the developer directory on macOS, the one the run reads, and
    // must not stop at a global configuration the sandbox hides.
    expect(access(join(TOOLS, 'usr', 'bin', 'git'))).toBe('read');
    expect(objectAt(objectAt(config, 'shell_environment_policy'), 'set')).toEqual({ ...confinedGitEnv(), DEVELOPER_DIR: TOOLS, PATH: `${TOOLS}/usr/bin:${process.env.PATH}` });
  });

  it('tells a run that reads no source nothing about Git, and grants it no developer directory', async () => {
    const dir = stubHarness('codex', ['{"type":"turn.completed","usage":{}}']);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const run = runDir();
    const selections: string[] = [];
    const mac = fakeMac();
    await collect(codexDriverWith({ ...mac, select: () => { selections.push('asked'); return mac.select(); } })
      .run({ ...run, prompt: 'extract', credentialEnv: {} }, new AbortController().signal));
    const config = parse(readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8')) as Record<string, unknown>;
    const filesystem = objectAt(objectAt(objectAt(config, 'permissions'), RUN_PERMISSIONS), 'filesystem') as Record<string, string | undefined>;
    expect({ developerDir: filesystem[TOOLS], policy: config.shell_environment_policy, selections })
      .toEqual({ developerDir: undefined, policy: { inherit: 'all', ignore_default_excludes: false }, selections: [] });
  });

  it('grants a source run no developer directory, and tells it none, where the one selected fails a check', async () => {
    const dir = stubHarness('codex', ['{"type":"turn.completed","usage":{}}']);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const run = runDir();
    // A developer directory another user owns is one nobody here chose to show the run.
    const logged: string[] = [];
    await collect(codexDriverWith(fakeMac({ paths: { [TOOLS]: { uid: 502, mode: 0o40755, kind: 'dir' }, [join(TOOLS, 'usr', 'bin', 'git')]: { uid: 0, mode: 0o100755, kind: 'file' } } }), (line) => { logged.push(line); })
      .run({ ...run, sourceReadOnly: true, prompt: 'map', credentialEnv: {} }, new AbortController().signal));
    // The worker says once which check failed, rather than letting the map lose its history in silence.
    expect(logged).toEqual([`a source run's git cannot run here, so the run reads no git history: ${TOOLS} is owned by neither root nor the user this worker runs as`]);
    const config = parse(readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8')) as Record<string, unknown>;
    const filesystem = objectAt(objectAt(objectAt(config, 'permissions'), RUN_PERMISSIONS), 'filesystem') as Record<string, string | undefined>;
    expect({ developerDir: filesystem[TOOLS], set: objectAt(objectAt(config, 'shell_environment_policy'), 'set') })
      .toEqual({ developerDir: undefined, set: confinedGitEnv() });
  });

  it('holds a run to its own sandbox whatever sandbox, permission profile or web search the machine configured', async () => {
    const machine = machineCodexHome({
      'auth.json': LOGIN,
      'config.toml': [
        'sandbox_mode = "danger-full-access"',
        'default_permissions = "mine"',
        'web_search = "live"',
        '',
        '[sandbox_workspace_write]',
        'writable_roots = ["/"]',
        '',
        '[permissions.mine.filesystem]',
        '":root" = "write"',
        '',
      ].join('\n'),
    });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      const run = runDir();
      await collect(codexDriver.run({ ...run, sourceReadOnly: true, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      const read = parse(readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8')) as Record<string, unknown>;
      expect({
        sandbox: read.sandbox_mode,
        roots: read.sandbox_workspace_write,
        profile: read.default_permissions,
        profiles: Object.keys(objectAt(read, 'permissions')),
        search: read.web_search,
      }).toEqual({ sandbox: undefined, roots: undefined, profile: RUN_PERMISSIONS, profiles: [RUN_PERMISSIONS], search: 'disabled' });
    } finally { machine.remove(); }
  });

  it('turns off every feature that reaches outside the run\'s sandbox or tools, and keeps credentials out of its commands\' environment, whatever the machine set', async () => {
    const machine = machineCodexHome({
      'auth.json': LOGIN,
      'config.toml': [
        '[features]',
        'memories = true',
        ...RUN_FEATURES_OFF.map((feature) => `${feature} = true`),
        '',
        '[shell_environment_policy]',
        'inherit = "all"',
        'ignore_default_excludes = true',
        'include_only = ["OPENAI_API_KEY"]',
        '',
      ].join('\n'),
    });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      const run = runDir();
      await collect(codexDriver.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
      const read = parse(readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8')) as Record<string, unknown>;
      expect(read.features).toEqual({ memories: true, ...Object.fromEntries(RUN_FEATURES_OFF.map((feature) => [feature, false])) });
      // Image viewing reads a file in the harness's own process, outside the sandbox (#1426).
      expect(RUN_FEATURES_OFF).toContain('view_image');
      expect(read.shell_environment_policy).toEqual({ inherit: 'all', ignore_default_excludes: false });
    } finally { machine.remove(); }
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

  it('does not let a selected machine profile override the claimed model or effort', async () => {
    const machine = machineCodexHome({
      'auth.json': LOGIN,
      'config.toml': [
        'profile = "personal"',
        'model = "root-model"',
        'model_reasoning_effort = "low"',
        '',
        '[profiles.personal]',
        'model = "personal-model"',
        'model_provider = "custom-provider"',
        'model_reasoning_effort = "xhigh"',
        '',
        '[model_providers.custom-provider]',
        'name = "Custom"',
        'base_url = "https://example.invalid"',
      ].join('\n'),
    });
    process.env.PATH = `${stubCodexReadingItsHome()}:${process.env.PATH ?? ''}`;
    try {
      const run = runDir();
      const events = await collect(codexDriver.run({
        ...run, prompt: 'do it', credentialEnv: {},
        profile: { tier: 'default', model: 'gpt-6.1', effort: 'medium', sources: { tier: 'task', model: 'configured' } },
      }, new AbortController().signal));
      expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
      const config = parse(readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8')) as Record<string, unknown>;
      expect({ model: config.model, effort: config.model_reasoning_effort, provider: config.model_provider }).toEqual({
        model: 'gpt-6.1', effort: 'medium', provider: 'custom-provider',
      });
      expect(config.profile).toBeUndefined();
      expect(config.profiles).toBeUndefined();
      expect(objectAt(config, 'model_providers')).toHaveProperty('custom-provider');
    } finally { machine.remove(); }
  });

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
        ...Object.fromEntries(RUN_FEATURES_OFF.map((feature) => [feature, false])),
        web_search: true,
        instructions: 'a machine writes prose here, and prose says things like\n[mcp_servers.playwright]\n',
        kept_after_the_string: true,
      });
      expect(read.tui).toEqual({ theme: 'dark' });
      expect(read.notify).toEqual(['a-command']);
      // A run queued from elsewhere answers no approvals and is bounded by its
      // own sandbox, whatever the machine allows the person in front of it.
      expect({ approval: read.approval_policy, profile: read.default_permissions }).toEqual({ approval: 'never', profile: RUN_PERMISSIONS });
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

/** The tools the run's server lists for a run, in place of asking a server. */
const RUN_TOOL_NAMES = ['myco_run', 'myco_run_sessions', 'noop_ping'];

/** The run's own agent, under the name these runs are given in place of one drawn for each. */
const RUN_AGENT = 'myco-run-test';
const ASKING = { asking: runAsking(harnessById('opencode'), RUN_AGENT) };

describe('the OpenCode run profile', () => {
  it('makes the claimed model the run configuration\'s own model and small model, which a session opens on', () => {
    const profile = { tier: 'default', model: 'openai/gpt-6.1', effort: 'medium', sources: { tier: 'task', model: 'configured' } } as const;
    const asking = runAsking(harnessById('opencode'), RUN_AGENT, profile);
    const config = JSON.parse(asking.env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown> & { agent: Record<string, Record<string, unknown>> };
    expect({ model: config.model, small_model: config.small_model }).toEqual({ model: 'openai/gpt-6.1', small_model: 'openai/gpt-6.1' });
    // OpenCode sends the session's model and effort with every prompt, so an agent's own would never be read.
    expect(Object.keys(config.agent[RUN_AGENT]!).sort()).toEqual(['description', 'mode', 'permission']);
  });
});

/** A session opened in the run's own agent, as OpenCode reports its mode. */
const RUN_AGENT_MODE = { configOptions: [{ id: 'mode', currentValue: RUN_AGENT }] };

/** A recorded `session/new` answer, with the session's mode the run's own agent. */
function inRunAgent(answer: Record<string, unknown>): Record<string, unknown> {
  const result = answer.result as { configOptions: Array<Record<string, unknown>> };
  return { ...answer, result: { ...result, configOptions: result.configOptions.map((option) => (option.id === 'mode' ? { ...option, currentValue: RUN_AGENT } : option)) } };
}
const listed = async (): Promise<RunTools> => ({ ok: true, names: new Set(RUN_TOOL_NAMES) });

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

/** OpenCode 1.18.29's answers on choosing a session's model, recorded per case (`opencode-1.18.29-acp-model-provenance.md`). */
const MODEL_RECORDING = JSON.parse(readFileSync(new URL('../fixtures/opencode-1.18.29-acp-model.json', import.meta.url), 'utf8')) as Record<string, Array<Record<string, unknown>>>;
/** The model every recorded case that offers one was configured or set to. */
const RECORDED_MODEL = 'openai/gpt-5.5';
const recorded = (name: string, id: number): Record<string, unknown> => MODEL_RECORDING[name]!.find((row) => row.id === id)!;
const offeredModels = (((recorded('configured', 2).result as { configOptions: Array<{ id: string; options: Array<{ value: string }> }> }).configOptions.find((o) => o.id === 'model'))!.options).map((o) => o.value);

/**
 * OpenCode as the recording shows it: a session opens on the run configuration's own model where a provider offers
 * it, and on OpenCode's default otherwise, whatever the run's agent names; `session/set_config_option` moves it; and
 * a prompt runs on whatever the session is on. Anything the recording does not hold is answered as an error.
 */
function recordedOpenCode(config: Record<string, unknown>): { channel: Channel; asked: string[]; promptedOn: () => Record<string, unknown> | null } {
  let current: Record<string, unknown> = {};
  let promptedOn: Record<string, unknown> | null = null;
  const on = (answer: Record<string, unknown>): Record<string, unknown> => {
    const options = (answer.result as { configOptions?: Array<{ id: string; currentValue: unknown }> } | undefined)?.configOptions;
    if (options !== undefined) current = Object.fromEntries(options.filter((o) => o.id !== 'mode').map((o) => [o.id, o.currentValue]));
    return answer;
  };
  const line = (answer: Record<string, unknown>, id: number): string => `${JSON.stringify({ ...answer, id })}\n`;
  const unrecorded = (id: number, what: string): string => `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: `unrecorded: ${what}` } })}\n`;
  const p = peer((method, id) => {
    if (method === 'initialize') return line(recorded('configured', 1), id);
    if (method === 'session/new') {
      const model = config.model;
      const name = model === undefined || model === 'opencode/big-pickle' ? 'default' : model === RECORDED_MODEL ? 'configured' : offeredModels.includes(String(model)) ? null : 'unknown';
      return name === null ? unrecorded(id, `a session opened on ${String(model)}`) : line(on(inRunAgent(recorded(name, 2))), id);
    }
    if (method === 'session/set_config_option') return null;
    if (method === 'session/prompt') {
      promptedOn = current;
      const notifications = MODEL_RECORDING.prompt!.filter((row) => typeof row.method === 'string').map((row) => JSON.stringify(row)).join('\n');
      return `${notifications}\n${line(recorded('prompt', 4), id)}`;
    }
    return line({ jsonrpc: '2.0', result: {} }, id);
  });
  // A set is answered from what it asks for, which the peer's method-only answer cannot see.
  const write = p.channel.write;
  p.channel.write = (text) => {
    const message = JSON.parse(text) as { id: number; method: string; params: { configId?: string; value?: string } };
    if (message.method !== 'session/set_config_option') { write(text); return; }
    p.asked.push(message.method);
    const { configId, value } = message.params;
    const answer = configId === 'model' && value === RECORDED_MODEL ? line(on(inRunAgent(recorded('set-model', 3))), message.id)
      : configId === 'effort' && value === 'medium' && current.model === RECORDED_MODEL ? line(on(inRunAgent(recorded('prompt', 3))), message.id)
        : unrecorded(message.id, `${String(configId)} set to ${String(value)}`);
    queueMicrotask(() => { readers.forEach((read) => { read(answer); }); });
  };
  const readers: Array<(line: string) => void> = [];
  const onLine = p.channel.onLine;
  p.channel.onLine = (read) => { readers.push(read); onLine(read); };
  return { channel: p.channel, asked: p.asked, promptedOn: () => promptedOn };
}

/** A turn on the recorded OpenCode, handed the configuration the driver writes for `configured` (none for null) and the claimed profile. */
async function onRecordedOpenCode(profile: ExecutionProfile, configured: ExecutionProfile | null = profile): Promise<{ events: RunEvent[]; asked: string[]; promptedOn: Record<string, unknown> | null }> {
  const asking = runAsking(harnessById('opencode'), RUN_AGENT, configured ?? undefined);
  const harness = recordedOpenCode(JSON.parse(asking.env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>);
  const events = await collect(turnOver(harness.channel, 'opencode', { ...runDir(), prompt: 'Reply with the single word ok', credentialEnv: {}, profile }, () => '', listed, { asking }));
  return { events, asked: harness.asked, promptedOn: harness.promptedOn() };
}

const claimed = (model: string, effort: string | null): ExecutionProfile => ({ tier: 'default', model, effort, sources: { tier: 'task', model: 'configured' } });

describe('the claimed model on OpenCode, as recorded (#1608)', () => {
  it('runs the prompt on the claimed model at the claimed effort, and reports that model', async () => {
    const { events, asked, promptedOn } = await onRecordedOpenCode(claimed(RECORDED_MODEL, 'medium'));
    expect(promptedOn).toEqual({ model: RECORDED_MODEL, effort: 'medium' });
    expect(asked).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt', 'session/close']);
    const identity = events.find((event) => event.kind === 'identity');
    expect(identity?.kind === 'identity' && identity.identity.status !== 'unknown' ? identity.identity.primary.model : null).toBe('gpt-5.5');
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });

  it('moves a session OpenCode opened on its own default to the claimed model before the prompt', async () => {
    const { events, asked, promptedOn } = await onRecordedOpenCode(claimed(RECORDED_MODEL, 'medium'), null);
    expect(promptedOn).toEqual({ model: RECORDED_MODEL, effort: 'medium' });
    const identity = events.find((event) => event.kind === 'identity');
    expect(identity?.kind === 'identity' && identity.identity.status !== 'unknown' ? identity.identity.primary.model : null).toBe('gpt-5.5');
    expect(asked).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt', 'session/close']);
  });

  it('never prompts a model OpenCode does not offer, ending the run with the profile unapplied', async () => {
    const { events, asked, promptedOn } = await onRecordedOpenCode(claimed('openai/gpt-0-unknown', 'medium'));
    expect(promptedOn).toBeNull();
    expect(asked).not.toContain('session/prompt');
    expect(events.some((event) => event.kind === 'started')).toBe(false);
    const last = events.at(-1);
    expect(last?.kind === 'ended' ? [last.stop, last.detail] : null).toEqual(['error', `profile_unapplied: it offers no model openai/gpt-0-unknown (it offers ${offeredModels.slice(0, 8).join(', ')} and ${offeredModels.length - 8} more)`]);
  });

  it('never prompts at an effort the claimed model does not offer', async () => {
    const { events, asked } = await onRecordedOpenCode(claimed(RECORDED_MODEL, 'max'));
    expect(asked).not.toContain('session/prompt');
    const last = events.at(-1);
    expect(last?.kind === 'ended' ? last.detail : null).toBe('profile_unapplied: it offers no effort max for this model (it offers none, low, medium, high, xhigh)');
  });

  it('runs a model that offers no effort, and records on its identity that the claimed effort was not applied', async () => {
    const { events, promptedOn } = await onRecordedOpenCode(claimed('opencode/big-pickle', 'medium'));
    expect(promptedOn).toEqual({ model: 'opencode/big-pickle' });
    const identities = events.filter((event) => event.kind === 'identity');
    expect(identities.length).toBeGreaterThan(0);
    expect(identities.every((event) => event.kind === 'identity' && event.identity.status !== 'unknown' && event.identity.warnings?.includes(EFFORT_UNAPPLIED) === true)).toBe(true);
  });

  it('records no effort warning on a run whose effort was applied', async () => {
    const { events } = await onRecordedOpenCode(claimed(RECORDED_MODEL, 'medium'));
    expect(events.some((event) => event.kind === 'identity' && event.identity.status !== 'unknown' && event.identity.warnings !== undefined)).toBe(false);
  });

  it('never prompts where the harness answers a set but keeps its model', async () => {
    const opened = inRunAgent(recorded('default', 2));
    const p = peer((method, id) => `${JSON.stringify({ ...(method === 'session/prompt' ? { jsonrpc: '2.0', result: { stopReason: 'end_turn' } } : opened), id })}\n`);
    const events = await collect(turnOver(p.channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {}, profile: claimed(RECORDED_MODEL, 'medium') }, () => '', listed, ASKING));
    expect(p.asked).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/close']);
    const last = events.at(-1);
    expect(last?.kind === 'ended' ? last.detail : null).toBe(`profile_unapplied: it kept the model opencode/big-pickle after being set to ${RECORDED_MODEL}`);
  });

  it('reads the options the agent announces when a set\'s reply carries none, and the efforts of the model it moved to', async () => {
    const opened = inRunAgent(recorded('default', 2));
    const announce = (answer: Record<string, unknown>): string => `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session_fixture', update: { sessionUpdate: 'config_option_update', configOptions: (inRunAgent(answer).result as { configOptions: unknown }).configOptions } } })}\n`;
    let current: Record<string, unknown> = {};
    let promptedOn: Record<string, unknown> | null = null;
    const p = peer((method, id) => {
      if (method === 'session/new') return `${JSON.stringify({ ...opened, id })}\n`;
      if (method === 'session/prompt') { promptedOn = current; return `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`; }
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`;
    });
    // Each set is answered with an empty reply, after the agent announces the options it moved to.
    const write = p.channel.write;
    const readers: Array<(line: string) => void> = [];
    const onLine = p.channel.onLine;
    p.channel.onLine = (read) => { readers.push(read); onLine(read); };
    p.channel.write = (text) => {
      const message = JSON.parse(text) as { id: number; method: string; params: { configId?: string } };
      if (message.method !== 'session/set_config_option') { write(text); return; }
      p.asked.push(message.method);
      const moved = message.params.configId === 'model' ? recorded('set-model', 3) : recorded('prompt', 3);
      current = Object.fromEntries((moved.result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions.filter((o) => o.id !== 'mode').map((o) => [o.id, o.currentValue]));
      const lines = `${announce(moved)}${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`;
      queueMicrotask(() => { readers.forEach((read) => { read(lines); }); });
    };
    const events = await collect(turnOver(p.channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {}, profile: claimed(RECORDED_MODEL, 'medium') }, () => '', listed, ASKING));
    expect(p.asked).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt', 'session/close']);
    expect(promptedOn as Record<string, unknown> | null).toEqual({ model: RECORDED_MODEL, effort: 'medium' });
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });

  it('never prompts where a set\'s reply carries no options and the agent announces none', async () => {
    const opened = inRunAgent(recorded('default', 2));
    const p = peer((method, id) => `${JSON.stringify({ ...(method === 'session/new' ? opened : { jsonrpc: '2.0', result: method === 'session/prompt' ? { stopReason: 'end_turn' } : {} }), id })}\n`);
    const events = await collect(turnOver(p.channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {}, profile: claimed(RECORDED_MODEL, 'medium') }, () => '', listed, ASKING));
    expect(p.asked).not.toContain('session/prompt');
    const last = events.at(-1);
    expect(last?.kind === 'ended' ? last.detail : null).toBe(`profile_unapplied: it reported no model after being set to ${RECORDED_MODEL}`);
  });

  it('gives every refusal a reason of its own, in words a reader meets on its page, whatever parentheses it or the detail holds', async () => {
    const opened = inRunAgent(recorded('default', 2));
    /** The ending a turn reaches against a peer that opens `session` and answers every other call with `other`. */
    const ending = async (other: (method: string) => Record<string, unknown>, session: Record<string, unknown> = opened, profile = claimed(RECORDED_MODEL, 'medium')) => {
      const p = peer((method, id) => `${JSON.stringify({ jsonrpc: '2.0', ...(method === 'session/new' ? session : other(method)), id })}\n`);
      const last = (await collect(turnOver(p.channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {}, profile }, () => '', listed, ASKING))).at(-1);
      return last?.kind === 'ended' ? last : null;
    };
    const recordedEnding = async (profile: ExecutionProfile) => {
      const last = (await onRecordedOpenCode(profile)).events.at(-1);
      return last?.kind === 'ended' ? last : null;
    };
    const configured = recorded('configured', 2).result as { configOptions: Array<Record<string, unknown>> };
    /** The configured session, with its effort option's current value removed. */
    const effortless = { result: { ...configured, configOptions: inRunAgent(recorded('configured', 2)).result && configured.configOptions.map((o) => (o.id === 'effort' ? { ...o, currentValue: undefined } : o.id === 'mode' ? { ...o, currentValue: RUN_AGENT } : o)) } };
    const endings = [
      await recordedEnding(claimed('openai/gpt-0-unknown', 'medium')),
      await recordedEnding(claimed(RECORDED_MODEL, 'max')),
      await ending((method) => (method === 'session/set_config_option' ? { error: { code: -32602, message: 'Invalid (params): model (unknown)' } } : { result: {} })),
      await ending(() => ({ result: {} })),
      await ending(() => ({ result: opened.result as Record<string, unknown> })),
      await ending(() => ({ result: {} }), { result: { sessionId: 's', ...RUN_AGENT_MODE } }),
      await ending(() => ({ result: effortless.result }), effortless, claimed(RECORDED_MODEL, 'high')),
    ];
    expect(endings.map((last) => last?.refusal)).toEqual([
      'it offers no model openai/gpt-0-unknown', 'it offers no effort max for this model', `it refused the model ${RECORDED_MODEL}`,
      `it reported no model after being set to ${RECORDED_MODEL}`, `it kept the model opencode/big-pickle after being set to ${RECORDED_MODEL}`, 'it reported no model for the session',
      'it kept the effort (none) after being set to high',
    ].map((reason) => ({ code: PROFILE_UNAPPLIED, reason })));
    // The detail keeps what the page leaves to technical details, nested parentheses and all.
    expect(endings[2]?.detail).toBe(`profile_unapplied: it refused the model ${RECORDED_MODEL} (Invalid (params): model (unknown))`);
    expect(endings[0]?.detail).toStartWith('profile_unapplied: it offers no model openai/gpt-0-unknown (it offers ');
    for (const last of endings) {
      const reason = last!.refusal!.reason!;
      expect({ reason, mechanism: MECHANISM_WORDS.test(reason) || RETIRED_VOCABULARY.test(reason) }).toEqual({ reason, mechanism: false });
    }
  });

  it('refuses rather than waits where the agent announces its options only after an empty set reply', async () => {
    const opened = inRunAgent(recorded('default', 2));
    const moved = inRunAgent(recorded('set-model', 3));
    const readers: Array<(line: string) => void> = [];
    const late = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session_fixture', update: { sessionUpdate: 'config_option_update', configOptions: (moved.result as { configOptions: unknown }).configOptions } } };
    const p = peer((method, id) => {
      if (method === 'session/new') return `${JSON.stringify({ ...opened, id })}\n`;
      // The announcement comes in a read of its own, after the reply has been read.
      if (method === 'session/set_config_option') setTimeout(() => { readers.forEach((read) => { read(`${JSON.stringify(late)}\n`); }); }, 20);
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: method === 'session/prompt' ? { stopReason: 'end_turn' } : {} })}\n`;
    });
    const onLine = p.channel.onLine;
    p.channel.onLine = (read) => { readers.push(read); onLine(read); };
    const events = await collect(turnOver(p.channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {}, profile: claimed(RECORDED_MODEL, 'medium') }, () => '', listed, ASKING));
    expect(p.asked).not.toContain('session/prompt');
    const last = events.at(-1);
    expect(last?.kind === 'ended' ? last.refusal : null).toEqual({ code: PROFILE_UNAPPLIED, reason: `it reported no model after being set to ${RECORDED_MODEL}` });
  });

  it('marks no effort skipped where the run claimed none', async () => {
    const { events, promptedOn } = await onRecordedOpenCode(claimed('opencode/big-pickle', null));
    expect(promptedOn).toEqual({ model: 'opencode/big-pickle' });
    expect(JSON.stringify(events.filter((event) => event.kind === 'identity'))).not.toContain(EFFORT_UNAPPLIED);
  });

  it('never prompts where the harness reports no model for its session', async () => {
    const p = peer((method, id) => `${JSON.stringify({ jsonrpc: '2.0', id, result: method === 'session/prompt' ? { stopReason: 'end_turn' } : { sessionId: 's', ...RUN_AGENT_MODE } })}\n`);
    const events = await collect(turnOver(p.channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {}, profile: claimed(RECORDED_MODEL, 'medium') }, () => '', listed, ASKING));
    expect(p.asked).not.toContain('session/prompt');
    const last = events.at(-1);
    expect(last?.kind === 'ended' ? last.detail === 'profile_unapplied: it reported no model for the session' : null).toBe(true);
  });
});

describe('the agent-protocol driver', () => {
  it('preserves recorded OpenCode tool outcomes and last-response usage without inventing an attempt total', async () => {
    const recording = readFileSync(new URL('../fixtures/opencode-1.18.21-acp-redacted.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const p = peer((method, id) => {
      if (method === 'session/close') return `${JSON.stringify({ id, result: {} })}\n`;
      const recorded = recording.find((row) => row.id === id)!;
      const response = method === 'session/new' ? inRunAgent(recorded) : recorded;
      const notifications = method === 'session/prompt' ? recording.filter((row) => typeof row.method === 'string') : [];
      return [...notifications, response].map((row) => JSON.stringify(row)).join('\n') + '\n';
    });
    const events = await collect(turnOver(p.channel, 'opencode', { ...runDir(), prompt: 'fixture', credentialEnv: {} }, () => '', listed, ASKING));
    expect(events.filter((event) => event.kind === 'tool_call')).toEqual([
      { kind: 'tool_call', name: 'fixture_fixture_receipt', status: 'started' },
      { kind: 'tool_call', name: 'fixture_fixture_receipt', status: 'ok' },
    ]);
    expect(events.find((event) => event.kind === 'usage')).toEqual({
      kind: 'usage', provider: 'openai', model: 'gpt-5.6-sol', tokenScope: 'last_response',
      inputTokens: 10206, outputTokens: 9, cachedTokens: 9984, cacheCreationTokens: null,
      reasoningTokens: null, costUsd: null, estimatedCostUsd: null,
    });
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });

  it('opens a session naming the run\'s server, prompts once, and answers the turn\'s stop reason', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => {
      if (method === 'initialize') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } })}\n`;
      if (method === 'session/new') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sess_acp', ...RUN_AGENT_MODE } })}\n`;
      if (method === 'session/prompt') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`;
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`;
    });
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => '', listed, ASKING));
    expect(events[0]).toEqual({ kind: 'started', harness: 'opencode', sessionId: 'sess_acp' });
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    expect(p.asked).toEqual(['initialize', 'session/new', 'session/prompt', 'session/close']);
  });

  it('answers a stop reason the protocol does not name as a failure', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => `${JSON.stringify({ jsonrpc: '2.0', id, result: method === 'session/prompt' ? { stopReason: 'something_else' } : { sessionId: 's', ...RUN_AGENT_MODE } })}\n`);
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => 'stderr said this', listed, ASKING));
    const last = events.at(-1)!;
    expect(last.kind).toBe('ended');
    if (last.kind === 'ended') { expect(last.stop).toBe('error'); expect(last.detail).toContain('stderr said this'); }
  });

  it('ends the run when the harness dies mid-turn rather than waiting on an answer that cannot come', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => {
      // The peer answers the handshake and then goes away without answering the prompt.
      if (method === 'session/prompt') { queueMicrotask(() => { p.close(); }); return null; }
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 's', ...RUN_AGENT_MODE } })}\n`;
    });
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => 'it exited 137', listed, ASKING));
    const last = events.at(-1)!;
    expect(last.kind).toBe('ended');
    if (last.kind === 'ended') { expect(last.stop).toBe('error'); expect(last.detail).toContain('closed the connection'); }
  });
});

/** How long an agent waits for the client to answer one of its requests before giving up on it. */
const AGENT_WAIT_MS = 1_000;

/** The options OpenCode offers with a permission request. */
const PERMISSION_OPTIONS = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
];

/** The options cursor-agent offered with every permission request in a recorded session. */
const CURSOR_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

const OUTSIDE_GRANT = 'outside the run\'s grant';

interface Turn {
  /** The id the client gave its prompt call. */
  promptId: number;
  /** Send the client a request under this id, and read its answer, or null when none came. */
  ask(id: number | string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** Send the client a session update. */
  update(update: Record<string, unknown>): void;
}

/**
 * An agent that makes requests of the client during its turn: `turn` runs when
 * the prompt arrives, and the prompt is answered with `end_turn` once it is done.
 */
function askingAgent(turn: (agent: Turn) => Promise<void>): Channel {
  let read: ((line: string) => void) | null = null;
  const send = (message: Record<string, unknown>): void => { queueMicrotask(() => read?.(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)); };
  const asked = new Map<number | string, (answer: Record<string, unknown>) => void>();
  const agent = (promptId: number): Turn => ({
    promptId,
    ask: (id, method, params) => new Promise((resolve) => {
      const timer = setTimeout(() => { asked.delete(id); resolve(null); }, AGENT_WAIT_MS);
      asked.set(id, (answer) => { clearTimeout(timer); resolve(answer); });
      send({ id, method, params });
    }),
    update: (update) => { send({ method: 'session/update', params: { sessionId: 'sess_acp', update } }); },
  });
  return {
    write: (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message.id as number | string;
      if (typeof message.method !== 'string') {
        const answered = asked.get(id);
        asked.delete(id);
        answered?.(message);
      } else if (message.method === 'session/new') send({ id, result: { sessionId: 'sess_acp', ...RUN_AGENT_MODE } });
      else if (message.method === 'session/prompt') void turn(agent(id as number)).then(() => { send({ id, result: { stopReason: 'end_turn' } }); });
      else send({ id, result: {} });
    },
    onLine: (fn) => { read = fn; },
    onClose: () => undefined,
  };
}

/** The option an answer to a permission request selected, or null when it selected none or none came. */
function chosenOption(answer: Record<string, unknown> | null): string | null {
  const outcome = (answer?.result as { outcome?: { optionId?: unknown } } | undefined)?.outcome;
  return typeof outcome?.optionId === 'string' ? outcome.optionId : null;
}

/** A permission request for this call, in the agent's session. */
const permissionFor = (toolCall: Record<string, unknown>, options = PERMISSION_OPTIONS): Record<string, unknown> => ({ sessionId: 'sess_acp', toolCall, options });

/** A turn's tool call events. */
const toolCalls = (events: readonly RunEvent[]): RunEvent[] => events.filter((e) => e.kind === 'tool_call');

describe('the agent-protocol driver answering what the agent asks of it', () => {
  it('allows a call inside the run\'s grant once, and the turn goes on to use it', async () => {
    const answers: unknown[] = [];
    const channel = askingAgent(async (agent) => {
      const call = { toolCallId: 'call_1', title: 'myco_myco_run', kind: 'other' };
      agent.update({ sessionUpdate: 'tool_call', ...call, status: 'pending' });
      const answer = await agent.ask('perm-1', 'session/request_permission', permissionFor(call));
      answers.push(answer?.result);
      if (chosenOption(answer) === 'once') agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
    });
    const events = await collect(turnOver(channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => '', listed, ASKING));
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }]);
    expect(toolCalls(events)).toEqual([
      { kind: 'tool_call', name: 'myco_myco_run', status: 'started' },
      { kind: 'tool_call', name: 'myco_myco_run', status: 'ok' },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });

  it('rejects a call outside the run\'s grant once, as that call failing once, and the turn\'s own end is the run\'s', async () => {
    const answers: unknown[] = [];
    const channel = askingAgent(async (agent) => {
      const shell = { toolCallId: 'call_1', title: 'ls', kind: 'execute', rawInput: { command: 'ls' } };
      agent.update({ sessionUpdate: 'tool_call', ...shell, status: 'pending' });
      answers.push((await agent.ask(0, 'session/request_permission', permissionFor(shell)))?.result);
      // The agent reports this refused call failed as well; the other it never reports.
      agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' });
      answers.push((await agent.ask(1, 'session/request_permission', permissionFor({ toolCallId: 'call_2', title: 'https://example.com', kind: 'fetch' })))?.result);
    });
    const events = await collect(turnOver(channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => '', listed, ASKING));
    const rejected = { outcome: { outcome: 'selected', optionId: 'reject' } };
    expect(answers).toEqual([rejected, rejected]);
    expect(toolCalls(events)).toEqual([
      { kind: 'tool_call', name: 'ls', status: 'started' },
      { kind: 'tool_call', name: 'ls', status: 'error', detail: OUTSIDE_GRANT },
      { kind: 'tool_call', name: 'https://example.com', status: 'error', detail: OUTSIDE_GRANT },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });

  it('answers from the same grant a Claude Code run holds: a source run\'s reads and scoped history commands, the run\'s listed tools, and nothing past them', async () => {
    const run = runDir();
    mkdirSync(join(run.scratchDir, 'repo'));
    const answerFor = async (toolCall: Record<string, unknown>, sourceReadOnly: boolean): Promise<string | null> => {
      let chosen: string | null = null;
      const channel = askingAgent(async (agent) => {
        chosen = chosenOption(await agent.ask(1, 'session/request_permission', permissionFor({ toolCallId: 'c', ...toolCall })));
      });
      await collect(turnOver(channel, 'opencode', { ...run, sourceReadOnly, prompt: 'read history', credentialEnv: {} }, () => '', listed, ASKING));
      return chosen;
    };
    const shell = (command: string): Record<string, unknown> => ({ kind: 'execute', title: command, rawInput: { command } });
    const cases: Array<[Record<string, unknown>, boolean, string]> = [
      [{ kind: 'other', title: 'mcp__myco__myco_run_sessions' }, false, 'once'],
      [{ kind: 'other', title: 'myco_myco_run' }, false, 'once'],
      [{ kind: 'other', title: 'mcp__myco__myco_unlisted' }, false, 'reject'],
      [{ kind: 'other', title: 'myco_myco_unlisted' }, false, 'reject'],
      // A tool of a user's own server named `myco-dev`, as OpenCode names it.
      [{ kind: 'other', title: 'myco_dev_search' }, false, 'reject'],
      [{ kind: 'other', title: 'mcp__mycox__foo' }, false, 'reject'],
      [{ kind: 'other', title: 'mycox_foo' }, false, 'reject'],
      [{ kind: 'read', title: 'repo/README.md' }, false, 'reject'],
      [{ kind: 'read', title: 'repo/README.md' }, true, 'once'],
      [shell('git -C repo log --oneline'), true, 'once'],
      [shell('git -C repo log --oneline'), false, 'reject'],
      [shell('git log | head'), true, 'reject'],
      [shell('git -C repo log -1\nrm -rf repo'), true, 'reject'],
      [shell('git -C repo log -1\rrm -rf repo'), true, 'reject'],
      [shell('git -C repo showx'), true, 'reject'],
      [shell('git -C repo push'), true, 'reject'],
      [{ kind: 'edit', title: 'myco_notes' }, true, 'reject'],
      // A file edit whose title happens to spell one of the run's tools.
      [{ kind: 'edit', title: 'myco_myco_run' }, true, 'reject'],
      // Cursor names a server and tool in its input: only the run's server, and only a listed tool.
      [{ kind: 'other', title: 'myco: myco_run', rawInput: { providerIdentifier: 'myco', toolName: 'myco_run' } }, false, 'once'],
      [{ kind: 'other', title: 'myco: unlisted', rawInput: { providerIdentifier: 'myco', toolName: 'unlisted' } }, false, 'reject'],
      [{ kind: 'other', title: 'myco-dev: myco_run', rawInput: { providerIdentifier: 'myco-dev', toolName: 'myco_run' } }, false, 'reject'],
      [{ kind: 'search', title: 'TODO', rawInput: { pattern: 'TODO' } }, true, 'once'],
      [{ kind: 'search', title: 'TODO', rawInput: { pattern: 'TODO' } }, false, 'reject'],
      [{ kind: 'search', title: 'react hooks', rawInput: { query: 'react hooks' } }, true, 'reject'],
      [{ kind: 'search', title: 'context7_resolve_library_id', rawInput: { libraryName: 'react' } }, true, 'reject'],
    ];
    for (const [toolCall, sourceReadOnly, expected] of cases) {
      expect({ toolCall, sourceReadOnly, chosen: await answerFor(toolCall, sourceReadOnly) }).toEqual({ toolCall, sourceReadOnly, chosen: expected });
    }
  });

  it('refuses a request that names another session, and reports nothing for this one', async () => {
    const answers: unknown[] = [];
    const channel = askingAgent(async (agent) => {
      answers.push((await agent.ask(1, 'session/request_permission', { ...permissionFor({ toolCallId: 'c', kind: 'other', title: 'myco_myco_run' }), sessionId: 'sess_other' }))?.result);
    });
    const events = await collect(turnOver(channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => '', listed, ASKING));
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject' } }]);
    expect(toolCalls(events)).toEqual([]);
  });

  it('never takes a request of the agent\'s for the answer to a call of its own, whatever id the request carries', async () => {
    const answers: unknown[] = [];
    const channel = askingAgent(async (agent) => {
      // The agent numbers its requests itself, and this one reuses the id of the prompt the client is waiting on.
      const answer = await agent.ask(agent.promptId, 'session/request_permission', permissionFor({ toolCallId: 'call_1', title: 'myco_myco_run', kind: 'other' }));
      answers.push(answer);
    });
    const events = await collect(turnOver(channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => '', listed, ASKING));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    expect(answers).toEqual([{ jsonrpc: '2.0', id: 3, result: { outcome: { outcome: 'selected', optionId: 'once' } } }]);
  });

  it('answers a request it does not implement as a method not found, so the agent does not wait on it', async () => {
    const answers: unknown[] = [];
    const channel = askingAgent(async (agent) => {
      answers.push(await agent.ask(7, 'fs/read_text_file', { sessionId: 'sess_acp', path: '/etc/hosts' }));
      answers.push(await agent.ask('term-1', 'terminal/create', { sessionId: 'sess_acp', command: 'ls' }));
    });
    const events = await collect(turnOver(channel, 'opencode', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => '', listed, ASKING));
    expect(answers).toEqual([
      { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: fs/read_text_file' } },
      { jsonrpc: '2.0', id: 'term-1', error: { code: -32601, message: 'Method not found: terminal/create' } },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });
});

/**
 * cursor-agent's own shapes, from a recorded session: its permission request
 * carries only what changed about a call, and what the call is was said in the
 * session's updates before it.
 */
describe('the agent-protocol driver answering cursor-agent', () => {
  const MCP_CALL = 'call-73d7b7b8-94c0-4ee7-8d2d-ecf76f3b8634-1\nfc_p2jeY2Y-4SRMt5-91d0bee7-aws_ue1_0';
  const SHELL_CALL = 'call-73d7b7b8-94c0-4ee7-8d2d-ecf76f3b8634-2\nfc_p2jeY2Y-4SRMt5-91d0bee7-aws_ue1_1';

  /** The recorded MCP call to the run server's `noop_ping`, up to its permission request; the answer is returned. */
  async function cursorMcpCall(agent: Turn): Promise<Record<string, unknown> | null> {
    agent.update({ sessionUpdate: 'tool_call', toolCallId: MCP_CALL, title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} });
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: MCP_CALL, title: 'myco: noop_ping', rawInput: { providerIdentifier: 'myco', toolName: 'noop_ping', args: {} } });
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: MCP_CALL, status: 'in_progress' });
    return agent.ask(0, 'session/request_permission', permissionFor({
      toolCallId: MCP_CALL, title: 'myco-noop_ping: noop_ping', kind: 'other', status: 'pending',
      content: [{ type: 'content', content: { type: 'text', text: '```json\n{}\n```' } }],
    }, CURSOR_OPTIONS));
  }

  /** The recorded shell call, up to its permission request; the answer is returned. */
  async function cursorShellCall(agent: Turn, command: string): Promise<Record<string, unknown> | null> {
    agent.update({ sessionUpdate: 'tool_call', toolCallId: SHELL_CALL, title: `\`${command}\``, kind: 'execute', status: 'pending', rawInput: { command } });
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: SHELL_CALL, status: 'in_progress' });
    return agent.ask(1, 'session/request_permission', permissionFor({
      toolCallId: SHELL_CALL, title: `\`${command}\``, kind: 'execute', status: 'pending',
      content: [{ type: 'content', content: { type: 'text', text: `Not in allowlist: ${command}` } }],
    }, CURSOR_OPTIONS));
  }

  it('allows a call of the run server\'s tool that the request itself names only by title', async () => {
    const answers: unknown[] = [];
    const channel = askingAgent(async (agent) => {
      answers.push((await cursorMcpCall(agent))?.result);
      agent.update({ sessionUpdate: 'tool_call_update', toolCallId: MCP_CALL, status: 'completed', rawOutput: { success: true } });
    });
    const events = await collect(turnOver(channel, 'cursor', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => '', listed));
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow-once' } }]);
    expect(toolCalls(events)).toEqual([
      { kind: 'tool_call', name: 'MCP: tool', status: 'started' },
      { kind: 'tool_call', name: 'myco: noop_ping', status: 'ok' },
    ]);
  });

  it('allows a source run\'s history read whose command only an earlier update carries, where the grant holds Git reads', async () => {
    const run = runDir();
    mkdirSync(join(run.scratchDir, 'repo'));
    const spec = { ...run, sourceReadOnly: true, prompt: 'read history', credentialEnv: {} };
    const answerFor = async (sourceGit: 'shim' | 'none'): Promise<unknown[]> => {
      const answers: unknown[] = [];
      const channel = askingAgent(async (agent) => { answers.push((await cursorShellCall(agent, 'git -C repo log'))?.result); });
      await collect(turnOver(channel, 'cursor', spec, () => '', listed, { grant: runGrant(spec, { sourceGit }) }));
      return answers;
    };
    expect(await answerFor('shim')).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow-once' } }]);
    // Cursor's own grant holds no Git reads: its shell does not reach the run's git.
    expect(await answerFor('none')).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject-once' } }]);
  });

  it('keeps a refused call failed when the agent then reports it completed', async () => {
    const answers: unknown[] = [];
    const channel = askingAgent(async (agent) => {
      answers.push((await cursorShellCall(agent, 'git status'))?.result);
      agent.update({ sessionUpdate: 'tool_call_update', toolCallId: SHELL_CALL, status: 'completed' });
    });
    const events = await collect(turnOver(channel, 'cursor', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => '', listed));
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject-once' } }]);
    expect(toolCalls(events)).toEqual([
      { kind: 'tool_call', name: '`git status`', status: 'started' },
      { kind: 'tool_call', name: '`git status`', status: 'error', detail: OUTSIDE_GRANT },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
  });

  it('refuses a web search in a source run: it is not a file search', async () => {
    const run = runDir();
    mkdirSync(join(run.scratchDir, 'repo'));
    const answers: unknown[] = [];
    const channel = askingAgent(async (agent) => {
      answers.push((await agent.ask(2, 'session/request_permission', permissionFor({ toolCallId: 'web_search_1', title: 'Search: secret source text', kind: 'search', status: 'pending' }, CURSOR_OPTIONS)))?.result);
    });
    await collect(turnOver(channel, 'cursor', { ...run, sourceReadOnly: true, prompt: 'read history', credentialEnv: {} }, () => '', listed));
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject-once' } }]);
  });

  it('ends the run before opening a session when the run\'s tools could not be listed, and says why', async () => {
    const p = peer((_method, id) => `${JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 's', ...RUN_AGENT_MODE } })}\n`);
    const unlisted = async (): Promise<RunTools> => ({ ok: false, reason: 'unauthorized: The upstream refused the credential (HTTP 401).' });
    const events = await collect(turnOver(p.channel, 'cursor', { ...runDir(), prompt: 'do it', credentialEnv: {} }, () => '', unlisted));
    expect(p.asked).toEqual(['initialize']);
    expect(events).toEqual([{
      kind: 'ended', stop: 'error',
      detail: 'the run\'s tools could not be listed: unauthorized: The upstream refused the credential (HTTP 401).',
    }]);
  });
});

describe('the tools a run\'s server lists for it', () => {
  /** An MCP server that lists these pages of tools, recording the credential each request carried. */
  function mcpServer(pages: string[][], status = 200): { url: string; seen: string[]; stop: () => void } {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        seen.push(request.headers.get('authorization') ?? '');
        if (status !== 200) return new Response('unavailable', { status });
        const message = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string; cursor?: string } };
        if (message.id === undefined) return new Response(null, { status: 202 });
        if (message.method === 'initialize') {
          return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'myco', version: '0' } } });
        }
        const page = Number(message.params?.cursor ?? '0');
        const tools = pages[page]!.map((name) => ({ name, inputSchema: { type: 'object' } }));
        return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools, ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}) } });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => { void server.stop(true); } };
  }

  it('reads every page the run\'s server lists, over the run\'s own credential', async () => {
    const server = mcpServer([['myco_run'], ['myco_run_sessions']]);
    try {
      const run = writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', { ...CONNECTION, serverUrl: server.url });
      const answers: unknown[] = [];
      const channel = askingAgent(async (agent) => {
        answers.push(chosenOption(await agent.ask(1, 'session/request_permission', permissionFor({ toolCallId: 'c', kind: 'other', title: 'myco_myco_run_sessions' }))));
      });
      await collect(turnOver(channel, 'opencode', { ...run, prompt: 'do it', credentialEnv: {} }, () => '', undefined, ASKING));
      expect(answers).toEqual(['once']);
      expect(new Set(server.seen)).toEqual(new Set([`Bearer ${CONNECTION.runToken}`]));
    } finally { server.stop(); }
  });

  it('answers why when the server will not list them', async () => {
    const server = mcpServer([], 503);
    try {
      const listing = await listRunTools({ url: `${server.url}/mcp`, headers: {} }, new AbortController().signal);
      expect(listing.ok).toBe(false);
      if (!listing.ok) expect(listing.reason).toContain('503');
    } finally { server.stop(); }
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
  // A fallback far above the answered wait, so a worker that kept its own
  // cadence would schedule it where the answered one belongs.
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

    // The waits are read from what the worker scheduled, not from how long it
    // took: elapsed time also counts harness detection, which a loaded machine
    // stretches past any bound that separates the two cadences.
    const scheduled: number[] = [];
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      scheduled.push(ms ?? 0);
      return nativeSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    try {
      await runWorker({
        serverUrl: 'https://deployment.example', token: 'tok', lockDir: null,
        runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
        pollIdleMs: FALLBACK_MS, log: () => {}, fetchImpl: profileWorkerServer(fetchImpl), signal: stopping.signal,
      });
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
    expect(asked.filter((p) => p === '/worker/claim').length).toBe(3);
    // Two waits between three claims, each at the answered cadence and none at the fallback.
    expect(scheduled.filter((ms) => ms === ANSWERED_POLL_MS || ms === FALLBACK_MS)).toEqual([ANSWERED_POLL_MS, ANSWERED_POLL_MS]);
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
            harness: 'claude-code', runToken: 'tok_run', credentialEnv: {}, profile: STUB_PROFILE, timeoutSeconds: 300,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/worker/lease')) { renewals += 1; return new Response(JSON.stringify({ persisted: true, held: true, expiresAt: 0 }), { status: 200 }); }
      if (url.endsWith('/worker/end')) { end.body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ persisted: true, ended: true }), { status: 200 }); }
      return new Response(JSON.stringify({ persisted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await runWorker({
      serverUrl: 'https://deployment.example', token: 'tok', lockDir: null,
      runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
      once: true, pollIdleMs: FALLBACK_MS, log: () => {}, fetchImpl: profileWorkerServer(fetchImpl), signal: stopping.signal,
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
      expect(stubProfileHarness({ holdUntil: release, ignoreTermination: true, pidFile })).toEqual(PROFILE_STUB_DETECTED);
      const fetchImpl = globalFetchDouble(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/worker/claim')) return Response.json({
          persisted: true, claimed: true, heartbeatMs: 100,
          run: {
            projectId: 'proj_1', id: 'run_overrun', task: 'title-summary', instruction: 'do it',
            harness: PROFILE_STUB_HARNESS, runToken: 'tok_run', credentialEnv: {}, profile: STUB_PROFILE, timeoutSeconds: 0,
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
        const outcome = await withRunMcp('https://deployment.example', (request) => listingOnly(request), () => runWorker({
          serverUrl: 'https://deployment.example', token: 'tok', lockDir: null, runRoot: join(scratch, 'runs'),
          only: [PROFILE_STUB_HARNESS], once: true, pollIdleMs: 100, log: (line) => { lines.push(line); }, fetchImpl: profileWorkerServer(fetchImpl), signal: stopping.signal,
        }));
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

describe('what a worker reports of a turn a failed call cut short', () => {
  it('reports a completed turn with the calls that failed, and that the turn ended right after one', async () => {
    // The harness refuses one call and ends its turn at once, as OpenCode does
    // after a `reject_once`: the stop reason alone reads as a clean finish.
    process.env.PATH = `${stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_cut"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"tu_1"}',
      '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[{"tool_name":"Bash","tool_use_id":"tu_1","tool_input":{"command":"ls"}}]}',
    ])}:${process.env.PATH ?? ''}`;
    const end: { body: Record<string, unknown> | null } = { body: null };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.endsWith('/worker/claim')) {
        return new Response(JSON.stringify({
          persisted: true, claimed: true, heartbeatMs: 60_000,
          run: { projectId: 'proj_1', id: 'run_cut', task: 'title-summary', instruction: 'do it', harness: 'claude-code', runToken: 'tok_run', credentialEnv: {}, profile: STUB_PROFILE, timeoutSeconds: 300 },
        }), { status: 200 });
      }
      if (url.endsWith('/worker/end')) { end.body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ persisted: true, ended: true }), { status: 200 }); }
      return new Response(JSON.stringify({ persisted: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await runWorker({
      serverUrl: 'https://deployment.example', token: 'tok', lockDir: null,
      runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
      once: true, pollIdleMs: 3_000, log: () => {}, fetchImpl: profileWorkerServer(fetchImpl), signal: new AbortController().signal,
    });
    expect({ status: end.body?.status, error: end.body?.error }).toEqual({
      status: 'completed',
      error: 'a call failed or was refused: Bash; the turn ended right after the last of them',
    });
  }, 15_000);
});

/**
 * Antigravity installed and logged in on this machine, as detection finds it:
 * a stub `agy`, a stub protocol sidecar that records that it was started, and
 * a settings file where the manifest declares its login. The home directory is
 * the test process's own throwaway (`tests/setup/sandbox-preload`).
 */
function stubAntigravity(): { started: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'myco-stub-agy-'));
  const started = join(dir, 'started');
  writeFileSync(join(dir, 'agy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(dir, 'agy_acp_server.par'), `#!/bin/sh\ntouch ${JSON.stringify(started)}\n`, { mode: 0o755 });
  const settings = credentialFile(harnessById('antigravity')!)!;
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['mcp(myco/myco_run)'] } }));
  process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
  return { started, remove: () => { rmSync(dirname(settings), { recursive: true, force: true }); } };
}

describe('a harness no worker offers', () => {
  it('is left out of every claim the worker makes, though detection finds it logged in', async () => {
    const agy = stubAntigravity();
    expect(stubAcpHarness()).toEqual(STUB_DETECTED);
    try {
      // The gate is not vacuous: the machine really has it, logged in.
      expect(detectHarnesses(['antigravity'])).toEqual([{ id: 'antigravity', installed: true, authenticated: true }]);
      const stopping = new AbortController();
      const claims: unknown[] = [];
      const logged: string[] = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/worker/claim')) {
          claims.push((JSON.parse(String(init?.body)) as { harnesses: unknown }).harnesses);
          stopping.abort();
          return new Response(JSON.stringify({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 10 }), { status: 200 });
        }
        return new Response(JSON.stringify({ persisted: true }), { status: 200 });
      }) as unknown as typeof fetch;
      await runWorker({
        serverUrl: 'https://deployment.example', token: 'tok', lockDir: null, only: ['antigravity', STUB_HARNESS],
        runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
        pollIdleMs: 3_000, log: (line) => { logged.push(line); }, fetchImpl: profileWorkerServer(fetchImpl), signal: stopping.signal,
      });
      expect(claims).toEqual([[{ id: STUB_HARNESS, installed: true, authenticated: true, profile: harnessById(STUB_HARNESS)!.profile }]]);
      expect(logged).toContain(`not offering antigravity: ${WITHHELD_REASON}`);
    } finally { agy.remove(); }
  }, 15_000);

  it('is never driven, even for a run a Deployment names it for: the run fails before anything starts', async () => {
    const agy = stubAntigravity();
    try {
      expect(driverFor('antigravity')).toBeNull();
      const end: { body: Record<string, unknown> | null } = { body: null };
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/worker/claim')) {
          return new Response(JSON.stringify({
            persisted: true, claimed: true, heartbeatMs: 60_000,
            run: { projectId: 'proj_1', id: 'run_agy', task: 'title-summary', instruction: 'do it', harness: 'antigravity', runToken: 'tok_run', credentialEnv: {}, timeoutSeconds: 300 },
          }), { status: 200 });
        }
        if (url.endsWith('/worker/end')) { end.body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ persisted: true, ended: true }), { status: 200 }); }
        return new Response(JSON.stringify({ persisted: true }), { status: 200 });
      }) as unknown as typeof fetch;
      await runWorker({
        serverUrl: 'https://deployment.example', token: 'tok', lockDir: null,
        runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
        once: true, pollIdleMs: 3_000, log: () => {}, fetchImpl: profileWorkerServer(fetchImpl), signal: new AbortController().signal,
      });
      expect({ status: end.body?.status, error: end.body?.error }).toEqual({ status: 'failed', error: `this worker does not drive antigravity: ${WITHHELD_REASON}` });
      expect(existsSync(agy.started)).toBe(false);
    } finally { agy.remove(); }
  }, 15_000);

  it('is named as not offered where the operator lists what the machine has', async () => {
    const agy = stubAntigravity();
    const printed: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
    try {
      expect(await runWorkerCli(['--detect', '--harness', 'antigravity'])).toBe(true);
    } finally { console.log = log; agy.remove(); }
    expect(printed).toEqual([`${'antigravity'.padEnd(14)} installed  logged in  not offered: ${WITHHELD_REASON}`]);
  });
});
