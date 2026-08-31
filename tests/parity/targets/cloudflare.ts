import fs from 'node:fs';
import path from 'node:path';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { GITHUB_SUB, MACHINE_ID, MEMBER_ID, PROJECT_ID, SESSION_SECRET, memberHeadersFor, type ParityTarget } from '../harness.ts';

const SERVER_DIR = path.resolve(import.meta.dir, '..', '..', '..', 'packages', 'myco-server');

// Every spawned process, killed at exit: a beforeAll timeout aborts the hook
// without running the target's stop(), and a live wrangler dev with piped
// stdio holds the CI job to its full timeout.
const SPAWNED = new Set<ReturnType<typeof Bun.spawn>>();
process.on('exit', () => {
  for (const proc of SPAWNED) {
    try { proc.kill(); } catch { /* already gone */ }
  }
});

/**
 * The parity config derived from the shipped wrangler.toml:
 * - `compatibility_flags` dropped — `global_fetch_strictly_public` blocks the
 *   loopback provider stub a scenario points the Deployment at;
 * - the `[assets]` table dropped — a fresh worktree holds no ui/dist, and every
 *   route a scenario touches is worker-owned under `run_worker_first`.
 * The file must sit inside packages/myco-server: wrangler resolves `main` and
 * `migrations_dir` relative to the config's own location.
 */
function deriveParityConfig(source: string): string {
  const lines = source.split('\n');
  const kept: string[] = [];
  let inAssets = false;
  for (const line of lines) {
    if (line.startsWith('compatibility_flags')) {
      if (!line.includes(']')) throw new Error('compatibility_flags spans lines; teach deriveParityConfig before reformatting wrangler.toml');
      const stripped = line.replace(/"global_fetch_strictly_public"\s*,?\s*/, '');
      if (/"/.test(stripped.split('=')[1] ?? '')) kept.push(stripped);
      continue;
    }
    if (line.trim() === '[assets]') { inAssets = true; continue; }
    if (inAssets && /^\[/.test(line.trim())) inAssets = false;
    if (!inAssets) kept.push(line);
  }
  return kept.join('\n');
}

async function wrangler(args: string[], env: Record<string, string | undefined> = {}): Promise<string> {
  const proc = Bun.spawn(['npx', '--no-install', 'wrangler', ...args], {
    cwd: SERVER_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  SPAWNED.add(proc);
  const timeout = Bun.sleep(120_000).then(() => { proc.kill(); return -1; });
  const [code, out, err] = await Promise.all([Promise.race([proc.exited, timeout]), new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  SPAWNED.delete(proc);
  if (code !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} exited ${code}: ${(err || out).slice(-2000)}`);
  return out;
}

/** The shipped Worker under wrangler dev: real workerd, real migrations, local D1/R2, a throwaway state dir. */
export async function bootCloudflare(): Promise<ParityTarget> {
  const tag = Math.random().toString(36).slice(2, 8);
  const configName = `wrangler.parity-${tag}.toml`;
  const configPath = path.join(SERVER_DIR, configName);
  const persistDir = path.join(SERVER_DIR, '.wrangler', `parity-state-${tag}`);
  fs.writeFileSync(configPath, deriveParityConfig(fs.readFileSync(path.join(SERVER_DIR, 'wrangler.toml'), 'utf8')));

  const d1 = (command: string) =>
    wrangler(['d1', 'execute', 'myco-server', '--local', '-c', configName, '--persist-to', persistDir, '--json', '--command', command]);

  const cleanup = () => {
    fs.rmSync(configPath, { force: true });
    fs.rmSync(persistDir, { recursive: true, force: true });
  };

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    await wrangler(['d1', 'migrations', 'apply', 'myco-server', '--local', '-c', configName, '--persist-to', persistDir]);

    const mint = Bun.spawn(['bun', 'scripts/mint-local.ts', MEMBER_ID, MACHINE_ID, '--print-token'], { cwd: SERVER_DIR, stdout: 'pipe', stderr: 'pipe' });
    const [mintCode, mintSql, mintEnv] = await Promise.all([mint.exited, new Response(mint.stdout).text(), new Response(mint.stderr).text()]);
    if (mintCode !== 0) throw new Error(`mint-local exited ${mintCode}: ${mintEnv}`);
    const token = /MYCO_MEMBER_TOKEN=(\S+)/.exec(mintEnv)?.[1];
    if (token === undefined) throw new Error('mint-local printed no token');
    await d1(mintSql.split('\n').filter((l) => !l.startsWith('--')).join(' '));
    await d1(`UPDATE members SET github_id='${GITHUB_SUB}' WHERE id='${MEMBER_ID}'`);

    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = probe.port;
    probe.stop(true);
    const logPath = path.join(SERVER_DIR, '.wrangler', `parity-dev-${tag}.log`);
    proc = Bun.spawn([
      'npx', '--no-install', 'wrangler', 'dev', '-c', configName, '--port', String(port), '--inspector-port', '0', '--persist-to', persistDir,
      '--var', `SESSION_SECRET:${SESSION_SECRET}`, '--var', 'GITHUB_CLIENT_ID:parity-client', '--var', 'GITHUB_CLIENT_SECRET:parity-secret',
    ], { cwd: SERVER_DIR, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    SPAWNED.add(proc);
    // Drain both streams continuously: wrangler stalls on backpressure, and the
    // buffer is the only readable evidence when a CI boot fails.
    let logText = '';
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) logText += decoder.decode(chunk);
    };
    const drained = Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>)])
      .then(() => fs.writeFileSync(logPath, logText))
      .catch(() => {});

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) { healthy = true; break; }
      } catch { /* not listening yet */ }
      await Bun.sleep(500);
    }
    if (!healthy) throw new Error(`wrangler dev never answered /health on ${port}; log tail:\n${logText.slice(-2_000)}`);

    const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: GITHUB_SUB, login: 'parity', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
    const devProc = proc;
    return {
      name: 'cloudflare',
      url,
      memberToken: token,
      projectId: PROJECT_ID,
      ownerHeaders: () => ({ cookie, 'cf-connecting-ip': '1.2.3.4' }),
      memberHeaders: (extra = {}) => memberHeadersFor(token, PROJECT_ID, extra),
      sql: async (command) => {
        const out = await d1(command);
        const parsed = JSON.parse(out) as Array<{ results: Record<string, unknown>[] }>;
        return parsed[0]?.results ?? [];
      },
      stop: async () => {
        devProc.kill();
        await Promise.race([devProc.exited, Bun.sleep(5_000)]);
        SPAWNED.delete(devProc);
        Bun.spawnSync(['pkill', '-f', `parity-${tag}`]);
        await Promise.race([drained, Bun.sleep(1_000)]);
        cleanup();
      },
    };
  } catch (error) {
    proc?.kill();
    if (proc !== null) SPAWNED.delete(proc);
    Bun.spawnSync(['pkill', '-f', `parity-${tag}`]);
    cleanup();
    throw error;
  }
}
