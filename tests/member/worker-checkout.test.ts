import { describe, expect, it } from 'bun:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWorker } from '@myco/runner/loop.js';
import { detectHarnesses } from '@myco/runner/detect.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { SEEDING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { gitRepositoryFixture, GIT_READ_CREDENTIAL } from '../helpers/git-repository.js';

/** A native child reads the checkout and writes through the run's HTTP MCP connection. */
const sourceReader = (evidence: string) => `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
if (process.argv.includes('status')) process.exit(0);
(async () => {
  const args = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.myco;
  const call = async (name, input) => {
    const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) });
    const body = await response.json();
    if (body.error || !body.result) throw new Error(JSON.stringify(body));
    const result = JSON.parse(body.result.content[0].text);
    if (result.ok === false) throw new Error(JSON.stringify(result));
    return result;
  };
  const git = (...args) => cp.execFileSync('git', ['-C', 'repo', ...args], { encoding: 'utf8' }).trim();
  const observed = { cwd: process.cwd(), args, commit: git('rev-parse', 'HEAD'), history: git('rev-list', '--count', 'HEAD'),
    source: fs.readFileSync('repo/AGENTS.md', 'utf8'), rules: fs.readFileSync('AGENTS.md', 'utf8'),
    gitConfig: fs.readFileSync('repo/.git/config', 'utf8'), gitTokenPresent: process.env.MYCO_GIT_TOKEN !== undefined };
  const saved = await call('myco_spores', { op: 'save', type: 'decision', content: 'The second commit revises the project rules (AGENTS.md).',
    agent_line: 'Read the current project rules in AGENTS.md before changing code.', tags: ['rules', 'history'] });
  if (!saved.id) throw new Error('No spore was saved');
  await call('myco_run', { op: 'report', action: ${JSON.stringify(SEEDING_REPORT_ACTION)}, summary: 'Read two commits and saved one observation.' });
  fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify(observed));
  console.log(JSON.stringify({ type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.05 }));
  console.log(JSON.stringify({ type: 'result', stop_reason: 'end_turn', is_error: false, permission_denials: [], total_cost_usd: 0.125, modelUsage: { model: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 20, cacheCreationInputTokens: 5 } } }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

describe('worker repository checkout over the Deployment wire', () => {
  for (const access of ['public', 'private', 'invalid'] as const) {
    it(access === 'invalid' ? 'refuses invalid repository credentials before launching a harness and removes scratch files' : `prepares ${access} source, saves spores under the run and removes its credentials and files`, async () => {
      const source = await gitRepositoryFixture(access === 'public' ? 'public' : 'private');
      const e = sqliteEnv();
      e.env.SECRET_WRAP_KEY = { get: async () => btoa('r'.repeat(32)) };
      const pipeline = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: fetch });
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => pipeline.handleRequest(request, e.serverEnv) });
      const previousPath = process.env.PATH;
      const origin = `http://127.0.0.1:${server.port}`;
      try {
        const now = Date.now();
        await ensureMember(e.db, 'mem_worker', now, 'admin', 'worker');
        const owner = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, now);
        await projectRepositories(e.db, deploymentSecretStore(e.db, e.serverEnv.wrappingKey)).save('proj_1', {
          url: source.url, branch: 'main', revision: null, credential: access === 'public' ? null : { ...GIT_READ_CREDENTIAL, ...(access === 'invalid' ? { token: 'revoked-fixture-read-token' } : {}) },
        }, 'mem_worker', now);
        e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id,capability,enabled,updated_at,updated_by) VALUES ('proj_1','vault_evolution',1,?,'test')`, [now]);
        e.sqlite.run(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [now]);
        e.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context)
          VALUES ('proj_1','run_seed','myco-agent','vault-seed','queued',?,'worker',?,'{}')`, [now, JSON.stringify({ serverUrl: origin, actor: 'mem_worker', timeoutSeconds: 30 })]);
        const binaries = join(source.home, 'bin');
        const runRoot = join(source.home, 'runs');
        const evidence = join(source.home, 'observed.json');
        await mkdir(binaries);
        await writeFile(join(binaries, 'claude'), sourceReader(evidence), { mode: 0o700 });
        process.env.PATH = `${binaries}:${previousPath ?? ''}`;
        expect(detectHarnesses(['claude-code'])).toEqual([{ id: 'claude-code', installed: true, authenticated: true }]);
        const lines: string[] = [];
        const outcome = await runWorker({ serverUrl: origin, token: owner.token, runRoot, only: ['claude-code'], once: true,
          repositoryGitPath: source.gitPath, pollIdleMs: 10, signal: AbortSignal.timeout(20_000), log: (line) => { lines.push(line); } });
        expect(outcome).toEqual({ driven: 1, refused: null });
        const row = e.sqlite.query(`SELECT status,error,run_context AS context FROM agent_runs WHERE id='run_seed'`).get() as { status: string; error: string | null; context: string };
        if (access !== 'invalid') {
          const accounting = e.sqlite.query(`SELECT tokens_used, cost_usd, actual_cost_usd, estimated_cost_usd, cost_source, usage_data FROM agent_runs WHERE id='run_seed'`).get() as Record<string, unknown>;
          expect(accounting).toMatchObject({ tokens_used: 38, cost_usd: 0.125, actual_cost_usd: null, estimated_cost_usd: 0.125, cost_source: 'estimated' });
          expect(JSON.parse(String(accounting.usage_data))).toEqual({ inputTokens: 35, outputTokens: 3, cachedTokens: 20, cacheCreationTokens: 5, costUsd: null, estimatedCostUsd: 0.125 });
        }
        if (access === 'invalid') {
          expect(row.status).toBe('failed');
          expect(row.error).toContain('Git operation failed');
          expect(row.error).not.toContain('revoked-fixture-read-token');
          expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM spores`).get()).toEqual({ n: 0 });
          expect(await readdir(runRoot)).toEqual([]);
          expect(await readdir(source.home)).not.toContain('observed.json');
          return;
        }
        if (row.status !== 'completed') throw new Error(`${JSON.stringify(row)}\n${lines.join('\n')}`);
        expect(row.error).toBeNull();
        expect(JSON.parse(row.context).repository).toEqual({ url: source.url, branch: 'main', commit: source.second });
        expect(e.sqlite.query(`SELECT author FROM spores`).all()).toEqual([{ author: 'run_seed' }]);
        const observed = JSON.parse(await readFile(evidence, 'utf8')) as Record<string, unknown>;
        expect(observed).toMatchObject({ commit: source.second, history: '2', source: 'Second committed rules.', gitTokenPresent: false });
        expect(observed.rules).toContain('# Myco seeding run');
        expect(observed.args).toContain('Bash(git -C repo log:*)');
        expect(JSON.stringify(observed)).not.toContain(GIT_READ_CREDENTIAL.token);
        expect(JSON.stringify(lines)).not.toContain(owner.token);
        expect(await readdir(runRoot)).toEqual([]);
      } finally {
        process.env.PATH = previousPath;
        server.stop(true);
        e.sqlite.close();
        await source.dispose();
      }
    }, 30_000);
  }
});
