// Gate G2 (#1561): how long a compiled binary takes to answer a hook that does no work.
//
// Usage: node scripts/measure-hook-startup.mjs <binary> [--runs N] [--max-p95-ms MS] [--prefix "arch -x86_64"]
//
// The hook is `user-prompt-submit` with stdin `{}`: it names no session, so it returns before it resolves a
// credential, and the time measured is the binary starting and reaching the hook's own chunk. It runs from a scratch
// directory under a scratch MYCO_HOME, so it reads and writes nothing of the machine's. On darwin the binary must pass
// `codesign --verify --strict` first: a binary the kernel would kill is not timed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const binary = args[0];
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
};
if (!binary || !fs.existsSync(binary)) {
  process.stderr.write(`[hook-startup] no binary at ${binary ?? '(none given)'}\n`);
  process.exit(2);
}
const runs = Number(flag('--runs', '20'));
const maxP95 = Number(flag('--max-p95-ms', process.platform === 'win32' ? '150' : '80'));
const prefix = flag('--prefix', '').split(' ').filter(Boolean);

if (process.platform === 'darwin') {
  const verified = spawnSync('codesign', ['--verify', '--strict', binary], { encoding: 'utf-8' });
  if (verified.status !== 0) {
    process.stderr.write(`[hook-startup] ${binary} fails codesign --verify --strict: ${verified.stderr}\n`);
    process.exit(1);
  }
}

// On POSIX the scratch directory is under /tmp, not $TMPDIR: on macOS a per-user $TMPDIR (/var/folders/…) can make
// every process started in it slow to launch, the binary's or not, which would time the machine rather than the hook.
const scratch = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'myco-hook-startup-'));
const env = { ...process.env, MYCO_HOME: path.join(scratch, 'home') };
fs.mkdirSync(env.MYCO_HOME);
const command = [...prefix, path.resolve(binary)];
const hookArgs = ['hook', 'user-prompt-submit', '--symbiont', 'claude-code', '--credential', 'registry'];

const once = () => {
  const started = process.hrtime.bigint();
  const run = spawnSync(command[0], [...command.slice(1), ...hookArgs], { cwd: scratch, env, input: '{}', encoding: 'utf-8', timeout: 30_000 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (run.status !== 0) {
    process.stderr.write(`[hook-startup] the hook exited ${run.status ?? run.signal}: ${run.stderr}\n`);
    process.exit(1);
  }
  return ms;
};

once();
const times = Array.from({ length: runs }, once).sort((a, b) => a - b);
const pick = (q) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)];
const p50 = pick(0.5);
const p95 = pick(0.95);
fs.rmSync(scratch, { recursive: true, force: true });
process.stdout.write(`[hook-startup] ${binary}${prefix.length ? ` via ${prefix.join(' ')}` : ''} on ${process.platform}-${process.arch}: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${runs} runs (ceiling ${maxP95} ms)\n`);
if (p95 > maxP95) {
  process.stderr.write(`[hook-startup] p95 ${p95.toFixed(1)} ms is over the ${maxP95} ms ceiling\n`);
  process.exit(1);
}
