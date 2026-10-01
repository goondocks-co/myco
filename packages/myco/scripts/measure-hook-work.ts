// Gate G1, timed (#1561): how long a compiled binary takes to answer each hook doing its real work.
//
// Usage: bun scripts/measure-hook-work.ts <binary> [--runs N (30)] [--scale S] [--prefix "arch -x86_64"]
//
// Each run is one session of the harness that wires every hook (session start, a prompt, a tool call's pre and post,
// a delegated agent's start and stop, the turn's end and the session's end), in a git repository joined to a loopback
// port nothing listens on, which refuses every connection at once: once with the credential read from the registry
// and once from the environment, whose turn and session ends deliver in the hook by design. Each hook's p95 over
// `--runs` sessions must stay inside its budget times `--scale` (1 where Linux runs natively; the shared macOS and
// Windows runners start a process about twice as slowly). This measures how long each hook's own work takes; that
// no hook dials the Deployment is G1's to prove (`tests/member/hook-no-network.test.ts`, against one that never
// answers).
//
// Everything runs under a scratch directory and a scratch MYCO_HOME, removed at the end; the detached helpers the
// registry's hooks start are waited for first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRegistryEntry, REGISTRY_VERSION } from '../src/member/registry.ts';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL } from '../src/member/credential.ts';
import { LifecycleLock } from '../src/utils/lifecycle-lock.ts';
import { helperPaths } from '../src/member/helper.ts';

const args = process.argv.slice(2);
const binary = args[0];
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
};
if (!binary || !fs.existsSync(binary)) {
  process.stderr.write(`[hook-work] no binary at ${binary ?? '(none given)'}\n`);
  process.exit(2);
}
// Thirty sessions: a p95 over them leaves out the one slowest run, so a single stall on a shared runner (a scan, a
// page-in) is not what the gate measures, and the budget still holds the other twenty-nine.
const runs = Number(flag('--runs', '30'));
const scale = Number(flag('--scale', process.platform === 'linux' ? '1' : '2'));
const prefix = flag('--prefix', '').split(' ').filter(Boolean);

/** Each hook's p95 budget, in ms, where Linux runs natively; session start and end run `git` for the branch and head. */
const BUDGET_MS: Record<string, number> = {
  'session-start': 250,
  'user-prompt-submit': 120,
  'pre-tool-use': 120,
  'post-tool-use': 120,
  'subagent-start': 120,
  'subagent-stop': 120,
  stop: 150,
  'session-end': 250,
};
const SYMBIONT = 'copilot';
const PROJECT = 'proj_hookwork';
/** A loopback port nothing listens on: every dial is refused at once. */
const DEPLOYMENT = 'http://127.0.0.1:9';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'myco-hook-work-')));
const repo = path.join(scratch, 'repo');
fs.mkdirSync(repo);
const git = (...gitArgs: string[]) => spawnSync('git', gitArgs, { cwd: repo, encoding: 'utf-8' });
git('init', '-q');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
const command = [...prefix, path.resolve(binary)];

function homeFor(source: 'registry' | 'env'): { home: string; env: NodeJS.ProcessEnv } {
  const home = path.join(scratch, `home-${source}`);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'machine_id'), `machine_hookwork_${source}`);
  const env: NodeJS.ProcessEnv = { ...process.env, MYCO_HOME: home };
  for (const key of [ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT, 'MYCO_JOIN_CODE']) delete env[key];
  if (source === 'registry') {
    const at = Date.now();
    writeRegistryEntry({
      version: REGISTRY_VERSION, projectId: PROJECT, serverUrl: DEPLOYMENT, token: 'mt_hookwork', root: repo,
      machineId: `machine_hookwork_${source}`, joinedAt: at, updatedAt: at, expiresAt: at + 86_400_000,
    }, { mycoHome: home });
  } else {
    Object.assign(env, { [ENV_SERVER_URL]: DEPLOYMENT, [ENV_MEMBER_TOKEN]: 'mt_hookwork', [ENV_PROJECT]: PROJECT });
  }
  return { home, env };
}

const times: Record<string, number[]> = {};
function hook(source: string, env: NodeJS.ProcessEnv, name: string, input: Record<string, unknown>): void {
  const started = process.hrtime.bigint();
  const run = spawnSync(command[0], [...command.slice(1), 'hook', name, '--symbiont', SYMBIONT, '--credential', source], {
    cwd: repo, env, input: JSON.stringify(input), encoding: 'utf-8', timeout: 30_000,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (run.status !== 0) {
    process.stderr.write(`[hook-work] ${source} ${name} exited ${run.status ?? run.signal}: ${run.stderr}\n`);
    process.exit(1);
  }
  (times[`${source} ${name}`] ??= []).push(ms);
}

function session(source: 'registry' | 'env', env: NodeJS.ProcessEnv, i: number): void {
  const sessionId = `sess-hookwork-${source}-${i}`;
  const transcript = path.join(scratch, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`);
  const base = { session_id: sessionId, sessionId, transcript_path: transcript, cwd: repo };
  hook(source, env, 'session-start', { ...base, hook_event_name: 'SessionStart' });
  hook(source, env, 'user-prompt-submit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: `prompt ${i}` });
  hook(source, env, 'pre-tool-use', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a' } });
  hook(source, env, 'post-tool-use', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: 'ok' });
  hook(source, env, 'subagent-start', { ...base, hook_event_name: 'SubagentStart', agent_id: `a${i}`, agent_type: 'Explore' });
  hook(source, env, 'subagent-stop', { ...base, hook_event_name: 'SubagentStop', agent_id: `a${i}`, agent_type: 'Explore' });
  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' } })}\n`);
  hook(source, env, 'stop', { ...base, hook_event_name: 'Stop', last_assistant_message: 'done' });
  hook(source, env, 'session-end', { ...base, hook_event_name: 'SessionEnd' });
}

let failed = false;
const homes: string[] = [];
try {
  for (const source of ['registry', 'env'] as const) {
    const { home, env } = homeFor(source);
    homes.push(home);
    // One session unmeasured, to warm the file cache.
    session(source, env, -1);
    for (const name of Object.keys(times)) delete times[name];
    for (let i = 0; i < runs; i++) session(source, env, i);
    for (const name of Object.keys(BUDGET_MS)) {
      const sorted = [...(times[`${source} ${name}`] ?? [])].sort((a, b) => a - b);
      const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
      const budget = BUDGET_MS[name] * scale;
      const over = pick(0.95) > budget;
      failed ||= over;
      process.stdout.write(`[hook-work] ${source.padEnd(8)} ${name.padEnd(18)} p50 ${pick(0.5).toFixed(1).padStart(6)} ms  p95 ${pick(0.95).toFixed(1).padStart(6)} ms  max ${sorted.at(-1)!.toFixed(1).padStart(6)} ms  (budget ${budget} ms)${over ? '  OVER' : ''}\n`);
    }
  }
} finally {
  // The registry's hooks started helpers apart from themselves: each lets its lock go once it has nothing to do.
  const lock = helperPaths(PROJECT, path.join(scratch, 'home-registry')).lock;
  for (let waited = 0; waited < 15_000; waited += 250) {
    const probe = fs.existsSync(lock) ? LifecycleLock.acquire(lock, { command: 'measure-hook-work' }) : null;
    if (probe === null || probe.acquired) { if (probe?.acquired) probe.lock.release(); break; }
    await Bun.sleep(250);
  }
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
if (failed) {
  process.stderr.write('[hook-work] a hook is over its budget\n');
  process.exit(1);
}
