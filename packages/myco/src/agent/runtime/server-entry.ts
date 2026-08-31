/**
 * The harness container entry: reads its dispatch from the environment, runs
 * one task through the lean runner, and serves the container port so the
 * Durable Object's hold and probes have something to talk to.
 */
import { ServerClient } from '@myco/member/transport.js';
import { runServerTask, type ServerTaskResult } from './server-runner.js';
import type { ProviderConfig } from '../types.js';

const startedAt = Date.now();
let result: ServerTaskResult | null = null;
let running = false;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

async function executeFromEnv(): Promise<void> {
  const serverUrl = env('MYCO_SERVER_URL');
  const token = env('MYCO_MEMBER_TOKEN');
  const projectId = env('MYCO_PROJECT');
  const runId = env('MYCO_RUN_ID');
  const taskName = env('MYCO_TASK');
  if (!serverUrl || !token || !projectId || !runId || !taskName) return;

  running = true;
  const providerJson = env('MYCO_PROVIDER_JSON');
  let provider: ProviderConfig | undefined;
  try {
    provider = providerJson === undefined ? undefined : JSON.parse(providerJson) as ProviderConfig;
  } catch {
    provider = undefined;
  }
  const client = new ServerClient({ serverUrl, token, projectId });
  result = await runServerTask({
    client,
    budget: { connectTimeoutMs: 10_000, requestTimeoutMs: 120_000 },
    runId,
    taskName,
    timeoutSeconds: Number.isFinite(Number(env('MYCO_TIMEOUT_SECONDS'))) ? Number(env('MYCO_TIMEOUT_SECONDS')) : 300,
    provider,
    model: env('MYCO_MODEL'),
    instruction: env('MYCO_INSTRUCTION'),
  });
  running = false;
  console.log(JSON.stringify({ kind: 'server_run_finished', ...result }));
}

Bun.serve({
  port: 8080,
  hostname: '0.0.0.0',
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/probe') {
      return Response.json({ ok: true, startedAt, uptimeMs: Date.now() - startedAt, pid: process.pid, running, result });
    }
    if (path === '/spawn') {
      const child = Bun.spawn(['sh', '-c', 'echo child-ok'], { stdout: 'pipe' });
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return Response.json({ code, out: out.trim() });
    }
    return new Response('not found', { status: 404 });
  },
});
console.log('harness entry up on 8080');

void executeFromEnv();
