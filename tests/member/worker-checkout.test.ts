import { budgetFixture } from '../myco-server/helpers/budget-fixture.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stubProfileHarness } from '../helpers/stub-profile-harness.ts';
import { join } from 'node:path';
import { dispatchTask } from '@myco-server-worker/core/harness.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { readCanopyMap } from '@myco-server-worker/read/canopy.js';
import { runWorker } from '@myco/runner/loop.js';
import { detectHarnesses } from '@myco/runner/detect.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '../myco-server/helpers/member-token.js';
import { connectRepository, githubFixture, SOURCE_URL, withApp } from '../myco-server/helpers/github-app.js';
import { SEEDING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { MAP_ACTION, MAP_TASK } from '@goondocks/myco-shared/canopy';
import { RUN_REPOSITORY_DIGESTS_FILE } from '@goondocks/myco-shared/repository';
import { createHash } from 'node:crypto';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { gitRepositoryFixture } from '../helpers/git-repository.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import { flagValue } from '../helpers/argv-flag.ts';

/**
 * A native child reads the checkout and writes through the run's HTTP MCP
 * connection: a seeding run saves a spore, and a map run writes a map grounded
 * in the digest listing the worker wrote beside the checkout. The source is the
 * repository the App connection names, served locally under its GitHub address,
 * reached with the token the Deployment minted and ended once Git is done.
 */

/** A source served under the fixture repository's GitHub address, accepting only live tokens the fixture issued. */
async function appSource(github: ReturnType<typeof githubFixture>, accepts = true) {
  return gitRepositoryFixture('private', { github: SOURCE_URL, accepts: (username, token) => accepts && username === 'x-access-token'
    && github.state.issued.some(entry => entry.token === token) && !github.state.revoked.includes(token) });
}
const sourceReader = (evidence: string, task: 'seed' | 'map' = 'seed') => `#!/usr/bin/env node
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
  const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8' }).trim();
  const observed = { cwd: process.cwd(), args, commit: git('rev-parse', 'HEAD'), history: git('rev-list', '--count', 'HEAD'),
    source: fs.readFileSync('AGENTS.md', 'utf8'), rules: fs.readFileSync('../AGENTS.md', 'utf8'),
    listing: fs.existsSync('../' + ${JSON.stringify(RUN_REPOSITORY_DIGESTS_FILE)}) ? fs.readFileSync('../' + ${JSON.stringify(RUN_REPOSITORY_DIGESTS_FILE)}, 'utf8') : null,
    gitConfig: fs.readFileSync('.git/config', 'utf8'), gitTokenPresent: process.env.MYCO_GIT_TOKEN !== undefined };
  if (${JSON.stringify(task)} === 'map') {
    // The calls a harness reports: a read and a history listing, each naming the checkout by its absolute path.
    const repo = process.cwd();
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: repo + '/AGENTS.md' } }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: 'rules' }] } }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_tree', name: 'Bash', input: { command: 'git -C ' + repo + ' ls-tree -r HEAD' } }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_tree', content: 'blob AGENTS.md' }] } }));
    const entry = (observed.listing || '').split('\\n').map((line) => line.split('  ')).find(([, path]) => path === 'AGENTS.md');
    if (!entry) throw new Error('The listing does not list AGENTS.md: ' + observed.listing);
    const groundedIn = [{ path: 'AGENTS.md', sha256: entry[0] }];
    await call('myco_run_map', { op: 'write', artifact: { directories: [{ path: 'AGENTS.md', annotation: 'The project rules.', groundedIn }],
      domains: [{ id: 'rules', title: 'Rules', files: [{ path: 'AGENTS.md', annotation: 'States the project rules.', groundedIn }] }] } });
    await call('myco_run', { op: 'report', action: ${JSON.stringify(MAP_ACTION)}, summary: 'Mapped the one committed file.', audit: ${JSON.stringify(RUN_AUDIT)} });
  } else {
    const saved = await call('myco_spores', { op: 'save', type: 'decision', content: 'The second commit revises the project rules (AGENTS.md).',
      agent_line: 'Read the current project rules in AGENTS.md before changing code.', tags: ['rules', 'history'] });
    if (!saved.id) throw new Error('No spore was saved');
    await call('myco_run', { op: 'report', action: ${JSON.stringify(SEEDING_REPORT_ACTION)}, summary: 'Read two commits and saved one observation.', audit: ${JSON.stringify(RUN_AUDIT)} });
  }
  fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify(observed));
  console.log(JSON.stringify({ type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.05 }));
  console.log(JSON.stringify({ type: 'result', stop_reason: 'end_turn', is_error: false, permission_denials: [], total_cost_usd: 0.125, modelUsage: { model: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 20, cacheCreationInputTokens: 5 } } }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

describe('worker repository checkout over the Deployment wire', () => {
  for (const access of ['private', 'invalid', 'invalid-older-server'] as const) {
    it(access.startsWith('invalid') ? 'refuses a token the source rejects before launching a harness and removes scratch files (' + access + ')' : 'prepares source with its minted token, saves spores under the run and ends the token and files', async () => {
      const github = githubFixture();
      const source = await appSource(github, access === 'private');
      const e = sqliteEnv({ workerLogin: true });
      const env = () => withApp(e.serverEnv, github);
      const pipeline = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: github.fetchImpl });
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
        const response = await pipeline.handleRequest(request, env());
        if (access === 'invalid-older-server') response.headers.set('x-myco-features', response.headers.get('x-myco-features')!.split(',').filter(feature => feature !== 'repository-failure-v1').join(','));
        return response;
      } });
      const previousPath = process.env.PATH;
      const origin = `http://127.0.0.1:${server.port}`;
      try {
        const now = Date.now();
        await ensureMember(e.db, 'mem_worker', now, 'admin', 'worker');
        const owner = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, now);
        await connectRepository(env(), 'proj_1', { actor: 'mem_worker', now });
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
        const outcome = await runWorker({ serverUrl: origin, token: owner.token, lockDir: null, runRoot, only: ['claude-code'], once: true,
          repositoryGitPath: source.gitPath, githubApi: github.fetchImpl, pollIdleMs: 10, signal: AbortSignal.timeout(20_000), log: (line) => { lines.push(line); } });
        expect(outcome).toEqual({ driven: 1, refused: null });
        const checkoutToken = github.state.issued.at(-1)!;
        expect(checkoutToken.body).toEqual({ permissions: { contents: 'read', metadata: 'read' }, repository_ids: [1296269] });
        expect(github.state.revoked).toContain(checkoutToken.token);
        const row = e.sqlite.query(`SELECT status,error,run_context AS context FROM agent_runs WHERE id='run_seed'`).get() as { status: string; error: string | null; context: string };
        if (!access.startsWith('invalid')) {
          const accounting = e.sqlite.query(`SELECT tokens_used, cost_usd, actual_cost_usd, estimated_cost_usd, cost_source, usage_data FROM agent_runs WHERE id='run_seed'`).get() as Record<string, unknown>;
          expect(accounting).toMatchObject({ tokens_used: 38, cost_usd: 0.125, actual_cost_usd: null, estimated_cost_usd: 0.125, cost_source: 'estimated' });
          expect(JSON.parse(String(accounting.usage_data))).toEqual({
            inputTokens: 35, outputTokens: 3, cachedTokens: 20, cacheCreationTokens: 5, costUsd: null, estimatedCostUsd: 0.125,
            model: 'model', provider: 'anthropic', accountingVersion: 1, identity: {
              status: 'reported', source: 'result.modelUsage', warnings: ['model_mismatch'], primary: { model: 'model', provider: 'anthropic' },
              models: [{ model: 'model', provider: 'anthropic', source: 'result.modelUsage', usage: {
                inputTokens: 35, outputTokens: 3, cachedTokens: 20, cacheCreationTokens: 5, costUsd: null, estimatedCostUsd: null,
              } }],
            },
          });
        }
        if (access.startsWith('invalid')) {
          expect(row.status).toBe('failed');
          expect(row.error).toBe('the worker failed while driving the run (repository_unprepared)');
          const context = JSON.parse(row.context);
          if (access === 'invalid-older-server') {
            expect(context.repositoryFailureCode).toBeUndefined();
            expect(context.repositoryFailureSummary).toBeUndefined();
          } else {
            expect(context.repositoryFailureCode).toBe('fetch_failed');
            expect(context.repositoryFailureSummary).toContain('fatal:');
          }
          expect(row.context).not.toContain(checkoutToken.token);
          expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM spores`).get()).toEqual({ n: 0 });
          expect(await readdir(runRoot)).toEqual([]);
          expect(await readdir(source.home)).not.toContain('observed.json');
          return;
        }
        if (row.status !== 'completed') throw new Error(`${JSON.stringify(row)}\n${lines.join('\n')}`);
        expect(row.error).toBeNull();
        expect(JSON.parse(row.context).repository).toEqual({ url: SOURCE_URL, branch: 'main', commit: source.second });
        expect(e.sqlite.query(`SELECT author FROM spores`).all()).toEqual([{ author: 'run_seed' }]);
        const observed = JSON.parse(await readFile(evidence, 'utf8')) as Record<string, unknown>;
        expect(observed).toMatchObject({ commit: source.second, history: '2', source: 'Second committed rules.', gitTokenPresent: false });
        expect(observed.rules).toContain('# Myco seeding run');
        // A seeding run grounds nothing in digests, so its checkout hashes nothing.
        expect(observed.listing).toBeNull();
        const args = observed.args as string[];
        expect(flagValue(args, '--allowedTools')!.split(',')).toContain('Bash(git -C repo log:*)');
        expect([flagValue(args, '--model'), flagValue(args, '--effort')]).toEqual(['sonnet', 'medium']);
        expect(JSON.stringify(observed)).not.toContain(checkoutToken.token);
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

  it('completes a map run with its digest listing and no inventory upload', async () => {
    const github = githubFixture();
    const source = await appSource(github);
    const e = sqliteEnv({ workerLogin: true });
    const env = () => withApp(e.serverEnv, github);
    const pipeline = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: github.fetchImpl });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      if (new URL(request.url).pathname === '/worker/repository') {
        expect(await request.clone().json()).not.toHaveProperty('files');
      }
      return pipeline.handleRequest(request, env());
    } });
    const previousPath = process.env.PATH;
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const now = Date.now();
      await ensureMember(e.db, 'mem_worker', now, 'admin', 'worker');
      const owner = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, now);
      await connectRepository(env(), 'proj_1', { actor: 'mem_worker', now });
      e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id,capability,enabled,updated_at,updated_by) VALUES ('proj_1','canopy',1,?,'test')`, [now]);
      e.sqlite.run(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [now]);
      e.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context)
        VALUES ('proj_1','run_map','myco-agent',?,'queued',?,'worker',?,'{}')`, [MAP_TASK, now, JSON.stringify({ serverUrl: origin, actor: 'mem_worker', timeoutSeconds: 30 })]);
      const binaries = join(source.home, 'bin');
      const evidence = join(source.home, 'observed.json');
      await mkdir(binaries);
      await writeFile(join(binaries, 'claude'), sourceReader(evidence, 'map'), { mode: 0o700 });
      process.env.PATH = `${binaries}:${previousPath ?? ''}`;
      const lines: string[] = [];
      const outcome = await runWorker({ serverUrl: origin, token: owner.token, lockDir: null, runRoot: join(source.home, 'runs'), only: ['claude-code'], once: true,
        repositoryGitPath: source.gitPath, githubApi: github.fetchImpl, pollIdleMs: 10, signal: AbortSignal.timeout(20_000), log: (line) => { lines.push(line); } });
      expect(outcome).toEqual({ driven: 1, refused: null });
      const row = e.sqlite.query(`SELECT status,error FROM agent_runs WHERE id='run_map'`).get() as { status: string; error: string | null };
      if (row.status !== 'completed') throw new Error(`${JSON.stringify(row)}\n${lines.join('\n')}`);
      const observed = JSON.parse(await readFile(evidence, 'utf8')) as { listing: string | null; source: string };
      // The listing names every committed file by the digest of its committed bytes.
      const digest = createHash('sha256').update(observed.source).digest('hex');
      expect(observed.listing).toBe(`${digest}  AGENTS.md\n`);
      const map = e.sqlite.query(`SELECT source_run_id AS runId, repository_commit AS commitId, artifact FROM canopy_maps WHERE project_id='proj_1'`).get() as { runId: string; commitId: string; artifact: string };
      expect({ runId: map.runId, commitId: map.commitId, grounded: JSON.parse(map.artifact).domains[0].files[0].groundedIn })
        .toEqual({ runId: 'run_map', commitId: source.second, grounded: [{ path: 'AGENTS.md', sha256: digest }] });
      // The step log names a file in the checkout relative to it, never by the run's random directory.
      const steps = e.sqlite.query(`SELECT kind, target FROM agent_run_steps WHERE run_id='run_map' AND kind IN ('read', 'command') ORDER BY seq`).all();
      expect(steps).toEqual([{ kind: 'read', target: 'AGENTS.md' }, { kind: 'command', target: 'git -C . ls-tree -r …' }]);
      const beforeCarry = (await readCanopyMap(e.db, { projectId: 'proj_1' }))!;
      await completeBudgetMigration(e.db, Date.now());
      const head = source.second;
      const automatic = await dispatchTask(env(), MAP_TASK, 'proj_1', { serverUrl: origin, actor: 'clock' }, Date.now());
      if (!automatic.dispatched) throw new Error('automatic map was not dispatched');
      await writeFile(evidence, 'harness has not started');
      const carried = await runWorker({ serverUrl: origin, token: owner.token, lockDir: null, runRoot: join(source.home, 'runs'),
        only: ['claude-code'], once: true, repositoryGitPath: source.gitPath, githubApi: github.fetchImpl, pollIdleMs: 10,
        signal: AbortSignal.timeout(20_000), log: line => { lines.push(line); } });
      expect(carried).toEqual({ driven: 1, refused: null });
      expect(await readFile(evidence, 'utf8')).toBe('harness has not started');
      expect((await getRun(e.db, { projectId: 'proj_1' }, automatic.runId))?.status).toBe('skipped');
      expect(await readCanopyMap(e.db, { projectId: 'proj_1' })).toMatchObject({
        artifact: beforeCarry.artifact, sourceRunId: beforeCarry.sourceRunId, repository: { commit: head },
      });
      expect(await readdir(join(source.home, 'runs'))).toEqual([]);

    } finally {
      process.env.PATH = previousPath;
      server.stop(true);
      e.sqlite.close();
      await source.dispose();
    }
  }, 30_000);
});

for (const failure of ['lfs','fetch_failed'] as const) it(`continues curation on knowledge after ${failure}, recording one event and one curation attempt`, async () => {
  const github=githubFixture();
  const source=await appSource(github,failure!=='fetch_failed');
  const e=await budgetFixture();
  const env=()=>withApp(e.serverEnv,github);
  const pipeline=createServer({now:()=>Date.now(),sourceOf:()=>'127.0.0.1',fetchImpl:github.fetchImpl});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>pipeline.handleRequest(request,env())});
  const origin=`http://127.0.0.1:${server.port}`;
  const previousPath=process.env.PATH;
  try {
    if(failure==='lfs') {
      await writeFile(join(source.repo,'large.bin'),'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n');
      source.git('add','large.bin');source.git('commit','--quiet','-m','LFS source');
    }
    await connectRepository(env(),'proj_1',{actor:'mem_worker',now:e.now});
    await settingsWriter(e.db).setCapability('proj_1','spore_curation',true,'mem_worker',e.now);
    const members=['a','b','c'].map(id=>({id,revision:0,closeness:6}));
    for(const member of members)e.sqlite.run("INSERT INTO spores(project_id,id,agent_id,content,observation_type,agent_line,created_at) VALUES('proj_1',?,'myco-agent','Distinct guidance','decision','Keep the guidance.',?)",[member.id,e.now]);
    e.sqlite.run("INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at) VALUES('proj_1','fixture',?,?)",[JSON.stringify(members),e.now]);
    const owner=await issueMemberToken(e.db,{memberId:'mem_worker',machineId:'m1'},e.now);
    const bin=join(source.home,'bin'),evidence=join(source.home,'knowledge.json');
    await mkdir(bin);
    await writeFile(join(bin,'claude'),`#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('status'))process.exit(0);
(async()=>{
 const args=process.argv.slice(2),flag=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1]};
 const prompt=flag('-p');
 fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({prompt,tools:flag('--tools'),cwd:process.cwd(),hasCheckout:fs.existsSync('repo')}));
 const config=JSON.parse(fs.readFileSync(flag('--mcp-config'),'utf8')).mcpServers.myco;
 const call=async(name,input)=>{
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:name,name:'mcp__myco__'+name,input}]}}));
  const response=await fetch(config.url,{method:'POST',headers:{...config.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}})});
  const body=await response.json(),result=JSON.parse(body.result.content[0].text);
  if(result.ok===false)throw new Error(JSON.stringify(result));
  return result;
 };
 await call('myco_run_curation',{op:'complete',decision:'keep',members:[{id:'a',revision:0},{id:'b',revision:0},{id:'c',revision:0}],reason:'Distinct knowledge; source unavailable.'});
 await call('myco_run',{op:'report',action:'curated',summary:'Kept knowledge apart.'});
 console.log(JSON.stringify({type:'result',stop_reason:'end_turn',is_error:false,modelUsage:{sonnet:{inputTokens:10,outputTokens:3}}}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
`,{mode:0o700});
    process.env.PATH=`${bin}:${previousPath}`;
    const lines:string[]=[];
    expect(await runWorker({serverUrl:origin,token:owner.token,lockDir:null,runRoot:join(source.home,'runs'),only:['claude-code'],once:true,
      repositoryGitPath:source.gitPath,githubApi:github.fetchImpl,pollIdleMs:10,signal:AbortSignal.timeout(20_000),log:line=>lines.push(line)})).toEqual({driven:1,refused:null});
    const run=e.sqlite.query("SELECT id,status,error,instruction,run_context FROM agent_runs WHERE task='curate-spores'").get() as {id:string;status:string;error:string|null;instruction:string;run_context:string};
    if(run.status!=='completed')throw new Error(JSON.stringify({run,lines}));
    const observed=JSON.parse(await readFile(evidence,'utf8'));
    expect(observed.prompt).toContain('No usable repository checkout is available');
    expect(observed.prompt).not.toContain('is pinned at its current commit');
    expect(observed.hasCheckout).toBe(false);
    expect(observed.tools).toBe('');
    expect(run.instruction).toBe(observed.prompt);
    expect(JSON.parse(run.run_context)).not.toHaveProperty('checkout');
    expect(e.sqlite.query("SELECT payload FROM agent_run_events WHERE run_id=? AND tool_name='worker_repository'").all(run.id))
      .toEqual([{payload:JSON.stringify({op:'unavailable',code:failure})}]);
    expect(e.sqlite.query("SELECT failures,decision FROM spore_curation_work WHERE cluster_key='fixture'").get()).toEqual({failures:1,decision:'keep'});
    expect(e.sqlite.query('SELECT COUNT(*) n FROM agent_run_attempts WHERE run_id=?').get(run.id)).toEqual({n:1});
  } finally {process.env.PATH=previousPath;server.stop(true);e.sqlite.close();await source.dispose();}
},30_000);

const LATE_ANSWERS = { kept: 'not stopped', declared: 'stopped as a whole answer of declared length arrives', chunked: 'stopped while a chunked answer of no declared length is still arriving' } as const;
for (const [arrival, words] of Object.entries(LATE_ANSWERS)) it(`revokes a checkout token exactly once when the run is ${words}`, async () => {
  const cancelled = arrival !== 'kept';
  const e = sqliteEnv({ workerLogin: true }), github = githubFixture();
  const root = await mkdtemp(join(tmpdir(), 'myco-late-token-'));
  const stopping = new AbortController();
  const safety = setTimeout(() => stopping.abort(), 10_000);
  try {
    stubProfileHarness();
    const failingGit = join(root, 'git');
    await writeFile(failingGit, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const now = Date.now(), origin = 'https://fixture.invalid';
    await ensureMember(e.db, 'mem_worker', now, 'admin', 'worker');
    const owner = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, now);
    const env = withApp(e.serverEnv, github);
    await connectRepository(env, 'proj_1', { actor: 'mem_worker', now });
    e.sqlite.run("INSERT OR IGNORE INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by) VALUES('proj_1','vault_evolution',1,?,'test')", [now]);
    e.sqlite.run("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','myco-agent','built-in',1,?)", [now]);
    e.sqlite.run("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context) VALUES('proj_1','run_seed','myco-agent','vault-seed','queued',?,'worker',?,'{}')",
      [now, JSON.stringify({ serverUrl: origin, actor: 'mem_worker', timeoutSeconds: 30 })]);
    const pipeline = createServer({ now: Date.now, sourceOf: () => '1.2.3.4', fetchImpl: github.fetchImpl });
    // The Deployment's answer arrives whole; with cancellation, the run is stopped the moment its body has been read.
    const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await pipeline.handleRequest(request, env);
      if (new URL(request.url).pathname !== '/worker/repository') return response;
      const text = await response.text();
      if (arrival === 'chunked') {
        // The run is stopped after the first half of the body; the rest still arrives, as a hosted Deployment's chunked answer does.
        const bytes = new TextEncoder().encode(text);
        const body = new ReadableStream<Uint8Array>({ async start(controller) {
          controller.enqueue(bytes.slice(0, bytes.length >> 1));
          await new Promise(resolve => setTimeout(resolve, 5));
          stopping.abort(new Error('stopped while the answer arrived'));
          await new Promise(resolve => setTimeout(resolve, 20));
          controller.enqueue(bytes.slice(bytes.length >> 1));
          controller.close();
        } });
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        return new Response(body, { status: response.status, headers });
      }
      const delivered = new Response(text, { status: response.status, headers: { ...Object.fromEntries(response.headers), 'content-length': String(Buffer.byteLength(text)) } });
      const read = delivered.text.bind(delivered);
      delivered.text = async () => { const body = await read(); if (cancelled) stopping.abort(new Error('stopped as the answer arrived')); return body; };
      return delivered;
    };
    const lines: string[] = [];
    await runWorker({ serverUrl: origin, token: owner.token, lockDir: null, runRoot: root, only: ['claude-code'], once: true, pollIdleMs: 1,
      signal: stopping.signal, fetchImpl: transport as typeof fetch, githubApi: github.fetchImpl, repositoryGitPath: failingGit, log: line => lines.push(line) });
    const checkout = github.state.issued.at(-1)!;
    expect(checkout.body).toEqual({ permissions: { contents: 'read', metadata: 'read' }, repository_ids: [1296269] });
    const deadline = Date.now() + 5_000;
    while (!github.state.revoked.includes(checkout.token) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(github.state.revoked.filter(token => token === checkout.token)).toHaveLength(1);
    for (const { token } of github.state.issued) expect(lines.join('\n')).not.toContain(token);
    // A stopped run never reads its source: its preparation failed for its caller.
    if (cancelled) expect(e.sqlite.query("SELECT status FROM agent_runs WHERE id='run_seed'").get()).not.toEqual({ status: 'completed' });
  } finally { clearTimeout(safety); stopping.abort(); e.sqlite.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);
