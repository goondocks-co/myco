import * as checkoutModule from '@myco/runner/repository-checkout.js';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCommittedFiles, prepareRepositoryCheckout, RepositoryCheckoutError, repositoryUrl } from '@myco/runner/repository-checkout.js';
import { prepareWorkerCheckout } from '@myco/runner/repository.js';
import { writeRunDir, discardRunDir } from '@myco/runner/mcp-config.js';
import { beginRunProcess, retryPendingRunDirectoryDiscards } from '@myco/runner/run-directory.js';
import { RUN_REPOSITORY_DIGESTS_FILE } from '@goondocks/myco-shared/repository';

import { gitRepositoryFixture, GIT_READ_CREDENTIAL } from '../helpers/git-repository.js';

let fixture: Awaited<ReturnType<typeof gitRepositoryFixture>>;
let home: string;
let repo: string;
let gitPath: string;
let first: string;
let second: string;
let url: string;
const token = GIT_READ_CREDENTIAL.token;
const git = (...args: string[]) => fixture.git(...args);

beforeAll(async () => {
  fixture = await gitRepositoryFixture();
  ({ home, repo, gitPath, first, second, url } = fixture);
}, 20_000);

afterAll(async () => { await fixture?.dispose(); });

const request = () => ({ url, branch: 'main', credential: { username: 'reader', token }, gitPath, signal: AbortSignal.timeout(15_000) });

describe('committed repository checkout', () => {
  it('supplies bounded history and removes its owned destination without removing pre-existing paths', async () => {
    const destination = join(home, 'run-source');
    const checkout = await prepareRepositoryCheckout({ ...request(), destination, historyDepth: 200, digests: true, pin: async (commit) => commit });
    try {
      expect(checkout.root).toBe(destination);
      expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: checkout.root, encoding: 'utf8' }).trim()).toBe('2');
      await expect(prepareRepositoryCheckout({ ...request(), destination, pin: async (commit) => commit })).rejects.toThrow();
      expect(await readFile(join(destination, 'AGENTS.md'), 'utf8')).toBe('Second committed rules.');
      expect(checkout.digests).toEqual([{ path: 'AGENTS.md', sha256: createHash('sha256').update('Second committed rules.').digest('hex') }]);
    } finally { await checkout.dispose(); }
    await expect(access(destination)).rejects.toThrow();
  });

  it('checks out the commit pinned for the run even when the branch has advanced', async () => {
    const checkout = await prepareRepositoryCheckout({ ...request(), pin: async (resolved) => { expect(resolved).toBe(second); return first; } });
    try {
      expect(checkout.commit).toBe(first);
      expect(checkout).not.toHaveProperty('digests');
      expect(await readFile(join(checkout.root, 'AGENTS.md'), 'utf8')).toBe('First committed rules.');
      const config = await readFile(join(checkout.root, '.git/config'), 'utf8');
      expect(config).not.toContain(token);
      expect(config).not.toContain('reader');
    } finally { await checkout.dispose(); }
    await expect(access(checkout.root)).rejects.toThrow();
  });

  it('configures no program in the checkout\'s repository: only its format and its remote', async () => {
    const checkout = await prepareRepositoryCheckout({ ...request(), pin: async (commit) => commit });
    try {
      const keys = execFileSync('git', ['config', '--file', join(checkout.root, '.git/config'), '--name-only', '--list'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      const format = ['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'core.symlinks'];
      expect(keys.filter((key) => !format.includes(key.toLowerCase()))).toEqual(['remote.origin.url', 'remote.origin.fetch']);
      const beside = ['info/attributes', 'config.worktree', 'commondir'].filter((path) => existsSync(join(checkout.root, '.git', path)));
      expect(beside).toEqual([]);
    } finally { await checkout.dispose(); }
  });

  it('uses a fresh workspace and committed content for each run', async () => {
    const a = await prepareRepositoryCheckout({ ...request(), pin: async (commit) => commit });
    const b = await prepareRepositoryCheckout({ ...request(), commit: first, pin: async (commit) => commit });
    try {
      expect(a.root).not.toBe(b.root);
      expect(a.commit).toBe(second);
      expect(b.commit).toBe(first);
      await writeFile(join(a.root, 'AGENTS.md'), 'task-local change');
      expect(await readFile(join(b.root, 'AGENTS.md'), 'utf8')).toBe('First committed rules.');
    } finally { await Promise.all([a.dispose(), b.dispose()]); }
  });

  it('compares the pinned tree with the prior map commit for changed-file discovery', async () => {
    const checkout = await prepareRepositoryCheckout({ ...request(), compareCommit: first, pin: async (commit) => commit });
    try {
      expect(checkout.commit).toBe(second);
      expect(checkout.changedPaths).toEqual(['AGENTS.md']);
    } finally { await checkout.dispose(); }
  });

  it('streams a digest of each named file, sorted, and leaves out a path a listing line cannot carry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myco-digests-'));
    try {
      await writeFile(join(root, 'b.ts'), 'b');
      await writeFile(join(root, 'a.ts'), 'a');
      await writeFile(join(root, 'split\nname.ts'), 'x');
      await writeFile(join(root, 'carriage\rname.ts'), 'y');
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');
      expect(await hashCommittedFiles(root, ['b.ts', 'split\nname.ts', 'a.ts', 'carriage\rname.ts'], AbortSignal.timeout(5_000)))
        .toEqual([{ path: 'a.ts', sha256: sha('a') }, { path: 'b.ts', sha256: sha('b') }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes the digest listing beside a worker checkout only when the run asks for one', async () => {
    const answer = async (input: Record<string, unknown>) => input.files !== undefined
      ? (expect(input.files).toEqual(['AGENTS.md']), {filesStored:true}) : input.commit === undefined
      ? { repository: { url, branch: 'main', credential: { username: 'reader', token } } }
      : { pin: { url, branch: 'main', commit: input.commit } };
    const spec = { url, branch: 'main', historyDepth: 1 };
    for (const digests of [true, false]) {
      const allocation = await mkdtemp(join(tmpdir(), 'myco-worker-checkout-'));
      const { scratchDir: scratch } = writeRunDir(allocation, 'run_checkout', { serverUrl: 'https://server.example.test', runToken: 'synthetic-run-token', projectId: 'project_fixture' });
      try {
        const checkout = await prepareWorkerCheckout(spec, scratch, AbortSignal.timeout(15_000), answer, { gitPath, digests });
        try {
          const listing = await readFile(join(scratch, RUN_REPOSITORY_DIGESTS_FILE), 'utf8').catch(() => null);
          expect({ digests, listing }).toEqual({ digests, listing: digests ? `${createHash('sha256').update('Second committed rules.').digest('hex')}  AGENTS.md\n` : null });
        } finally { await checkout.dispose(); }
      } finally { discardRunDir(scratch); await rm(allocation, { recursive: true, force: true }); }
    }
  });

  it('preserves worker checkout files until their registered harness owner exits', async () => {
    const allocation = await mkdtemp(join(tmpdir(), 'myco-worker-checkout-'));
    const { scratchDir } = writeRunDir(allocation, 'run_owned_checkout', { serverUrl: 'https://server.example.test', runToken: 'synthetic-run-token', projectId: 'project_fixture' });
    const answer = async (input: Record<string, unknown>) => input.commit === undefined
      ? { repository: { url, branch: 'main', credential: { username: 'reader', token } } }
      : { pin: { url, branch: 'main', commit: input.commit } };
    const checkout = await prepareWorkerCheckout({ url, branch: 'main', historyDepth: 1 }, scratchDir, AbortSignal.timeout(15_000), answer, { gitPath });
    const launch = beginRunProcess(scratchDir)!;
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: checkout.root, detached: process.platform !== 'win32', stdio: 'ignore', env: process.env });
    const exited = new Promise<void>((resolve) => owner.once('close', () => resolve()));
    launch.started(owner.pid!);
    try {
      await expect(checkout.dispose()).rejects.toThrow('harness owner');
      expect(await readFile(join(checkout.root, 'AGENTS.md'), 'utf8')).toBe('Second committed rules.');
    } finally {
      process.kill(process.platform === 'win32' ? owner.pid! : -owner.pid!, 'SIGKILL');
      await exited;
      retryPendingRunDirectoryDiscards();
      discardRunDir(scratchDir);
      await rm(allocation, { recursive: true, force: true });
    }
    expect(existsSync(scratchDir)).toBe(false);
  });

  it('refuses invalid credentials without exposing them', async () => {
    let message = '';
    try {
      await prepareRepositoryCheckout({ ...request(), credential: { username: 'reader', token: 'revoked-fixture-token' }, pin: async (commit) => commit });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain('Git operation failed');
    expect(message).not.toContain('revoked-fixture-token');
  });

  it('refuses cancellation and a failed pin before exposing a workspace', async () => {
    await expect(prepareRepositoryCheckout({ ...request(), signal: AbortSignal.abort(), pin: async (commit) => commit })).rejects.toThrow();
    await expect(prepareRepositoryCheckout({ ...request(), pin: async () => { throw new Error('run is no longer held'); } })).rejects.toThrow('run is no longer held');
  });

  it('accepts only explicit HTTPS repository URLs without embedded credentials', () => {
    for (const url of ['file:///etc', 'http://example.test/repo', 'https://token@example.test/repo', 'https://example.test/repo?token=secret', 'https://example.test/']) {
      expect(() => repositoryUrl(url)).toThrow();
    }
    expect(repositoryUrl('https://example.test/team/repo.git')).toBe('https://example.test/team/repo.git');
  });
});

describe('a checkout a task is given', () => {
  it('refuses unsupported LFS content before giving a task any files', async () => {
    await writeFile(join(repo, 'large.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n');
    git('add', 'large.bin'); git('commit', '--quiet', '-m', 'lfs pointer');
    try {
      await expect(prepareRepositoryCheckout({ ...request(), pin: async (commit) => commit })).rejects.toMatchObject({ failure: { code: 'lfs' } });
    } finally { git('reset', '--hard', second); }
  });

  it('refuses submodule source before giving a task any files', async () => {
    git('update-index', '--add', '--cacheinfo', `160000,${first},dependency`);
    git('commit', '--quiet', '-m', 'submodule');
    try {
      await expect(prepareRepositoryCheckout({ ...request(), pin: async (commit) => commit })).rejects.toMatchObject({ failure: { code: 'submodules' } });
    } finally { git('reset', '--hard', second); }
  });
});

it('carries a bounded fetch reason with exact credentials and URL userinfo removed from stderr', async () => {
  const executable = join(home, 'git-stderr-fixture');
  const credential = { username: 'fixture-user', token: 'a!b' };
  await writeFile(executable, '#!/usr/bin/env node\n' + `
const cp = require('node:child_process');
if (process.argv.includes('fetch')) {
  const token = process.env.MYCO_GIT_TOKEN;
  process.stderr.write('fatal: Could not read source ' + token + ' https://' + process.env.MYCO_GIT_USERNAME + ':' + encodeURIComponent(token) + '@example.test/source.git\\n');
  process.exit(128);
}
cp.execFileSync('git', process.argv.slice(2), { stdio: 'inherit' });
`, { mode: 0o700 });
  let failure: RepositoryCheckoutError | undefined;
  try { await prepareRepositoryCheckout({ ...request(), credential, gitPath: executable, pin: async commit => commit }); }
  catch (error) { expect(error).toBeInstanceOf(RepositoryCheckoutError); failure = error as RepositoryCheckoutError; }
  expect(failure?.failure.code).toBe('fetch_failed');
  expect(failure?.failure.summary).toContain('fatal: Could not read source');
  expect(failure?.failure.summary!.length).toBeLessThanOrEqual(512);
  expect(JSON.stringify(failure?.failure)).not.toContain(credential.token);
  expect(JSON.stringify(failure?.failure)).not.toContain(encodeURIComponent(credential.token));
  expect(JSON.stringify(failure?.failure)).not.toContain(credential.username);
});

for (const [operation, output, reason] of [
  ['ls-tree', '100644 blob ' + 'a'.repeat(40) + ' 268435457\tlarge.bin\0', 'too_large'],
  ['rev-parse', 'b'.repeat(40) + '\n', 'commit_mismatch'],
] as const) it(`reports ${reason} as a closed repository reason`, async () => {
  const executable = join(home, 'git-' + reason);
  await writeFile(executable, '#!/usr/bin/env node\n' + `
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes(${JSON.stringify(operation)}) && (${JSON.stringify(operation)} !== 'rev-parse' || args.at(-1) === 'HEAD')) {
  process.stdout.write(${JSON.stringify(output)});
} else cp.execFileSync(${JSON.stringify(gitPath)}, args, { stdio: 'inherit' });
`, { mode: 0o700 });
  await expect(prepareRepositoryCheckout({ ...request(), gitPath: executable, pin: async commit => commit })).rejects.toMatchObject({ failure: { code: reason } });
});

it('keeps public fetch diagnostics readable and redacts unexpected URL userinfo', async () => {
  const executable = join(home, 'git-public-stderr-fixture');
  await writeFile(executable, '#!/usr/bin/env node\n' + `
const cp = require('node:child_process');
if (process.argv.includes('fetch')) {
  process.stderr.write('fatal: cannot read https://reader:shortpw@example.test/source.git');
  process.exit(128);
}
cp.execFileSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: 'inherit' });
`, { mode: 0o700 });
  let failure: RepositoryCheckoutError | undefined;
  try { await prepareRepositoryCheckout({ ...request(), credential: undefined, gitPath: executable, pin: async commit => commit }); }
  catch (error) { expect(error).toBeInstanceOf(RepositoryCheckoutError); failure = error as RepositoryCheckoutError; }
  expect(failure?.failure.summary).toContain('fatal: cannot read https://example.test');
  expect(JSON.stringify(failure?.failure)).not.toContain('shortpw');
  expect(JSON.stringify(failure?.failure)).not.toContain('reader:');
});


it('continues mapping without posting an oversized committed inventory',async()=>{
  const files=Array.from({length:6000},(_,i)=>`src/${i}-${'a'.repeat(100)}.ts`);
  const prepare=spyOn(checkoutModule,'prepareRepositoryCheckout').mockResolvedValue({root:'unused',commit:'a'.repeat(40),files,dispose:async()=>{}});
  const calls:Record<string,unknown>[]=[];
  try {
    const checkout=await prepareWorkerCheckout({url,branch:'main',historyDepth:1},home,AbortSignal.timeout(1000),async input=>{
      calls.push(input);return {repository:{url,branch:'main'}};
    },{digests:true});
    expect(calls).toEqual([{}]);
    await checkout.dispose();
  }finally{prepare.mockRestore();}
});

it('refreshes only the connected branch and prunes old pins while preparing independent knowledge checkouts', async () => {
  const cacheRoot=join(home,'runner-cache');
  const counter=join(home,'cache-commands.json');
  const executable=join(home,'git-cache-fixture');
  await writeFile(counter,JSON.stringify({init:0,clone:0,remoteFetch:0,refspecs:[]}));
  await writeFile(executable,'#!/usr/bin/env node\n'+`
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);
const counter=${JSON.stringify(counter)};
const counts=JSON.parse(fs.readFileSync(counter,'utf8'));
if(args.includes('init'))counts.init++;
if(args.includes('clone'))counts.clone++;
if(args.includes('fetch')&&args.some(arg=>arg.startsWith('https://'))){counts.remoteFetch++;counts.refspecs.push(args[args.length-1]);}
fs.writeFileSync(counter,JSON.stringify(counts));
const child=cp.spawnSync(${JSON.stringify(gitPath)},args,{stdio:'inherit'});
process.exit(child.status??1);
`,{mode:0o700});
  const checkouts: Awaited<ReturnType<typeof prepareRepositoryCheckout>>[]=[];
  git('branch','unconnected',first);
  try {
    const a=await prepareRepositoryCheckout({...request(),gitPath:executable,cacheRoot,pin:async commit=>commit});
    checkouts.push(a);
    await writeFile(join(repo,'AGENTS.md'),'Third committed rules.');
    git('commit','--quiet','-am','third');
    const third=git('rev-parse','HEAD');
    const [b,c]=await Promise.all([
      prepareRepositoryCheckout({...request(),gitPath:executable,cacheRoot,pin:async commit=>commit}),
      prepareRepositoryCheckout({...request(),gitPath:executable,cacheRoot,commit:second,pin:async commit=>commit}),
    ]);
    checkouts.push(b,c);
    expect([a.commit,b.commit,c.commit]).toEqual([second,third,second]);
    expect(await readFile(join(b.root,'AGENTS.md'),'utf8')).toBe('Third committed rules.');
    expect(await readFile(join(c.root,'AGENTS.md'),'utf8')).toBe('Second committed rules.');
    await writeFile(join(a.root,'AGENTS.md'),'local change');
    expect(await readFile(join(b.root,'AGENTS.md'),'utf8')).toBe('Third committed rules.');
    for(const checkout of checkouts) expect(existsSync(join(checkout.root,'.git/objects/info/alternates'))).toBe(false);
    const mirror=join(cacheRoot,createHash('sha256').update(url).digest('hex'),'mirror.git');
    expect(execFileSync('git',['-C',mirror,'rev-parse','--is-shallow-repository'],{encoding:'utf8'}).trim()).toBe('true');
    expect(execFileSync('git',['-C',mirror,'for-each-ref','--format=%(refname)','refs/heads/'],{encoding:'utf8'}).trim()).toBe('refs/heads/main');
    const pins=execFileSync('git',['-C',mirror,'for-each-ref','--format=%(refname)','refs/myco/pins/'],{encoding:'utf8'}).trim().split('\n');
    expect(pins).toHaveLength(1);
    expect([second,third]).toContain(pins[0]!.split('/').at(-1)!);
    expect(JSON.parse(await readFile(counter,'utf8'))).toEqual({init:1,clone:3,remoteFetch:3,refspecs:Array(3).fill('+refs/heads/main:refs/heads/main')});
    await expect(prepareRepositoryCheckout({...request(),cacheRoot:join(home,'new-runner-cache'),commit:first,pin:async commit=>commit}))
      .rejects.toMatchObject({failure:{code:'checkout_failed'}});
    expect(await readFile(join(a.root,'.git/config'),'utf8')).not.toContain(token);
    const denied=prepareRepositoryCheckout({...request(),cacheRoot,credential:{username:'reader',token:'revoked-fixture-token'},pin:async commit=>commit});
    await expect(denied).rejects.toMatchObject({failure:{code:'fetch_failed'}});
    expect(await readFile(join(b.root,'AGENTS.md'),'utf8')).toBe('Third committed rules.');
  } finally {
    await Promise.all(checkouts.map(checkout=>checkout.dispose()));
    git('reset','--hard',second);
    git('branch','-D','unconnected');
  }
});

it('map and seed history reads need no repository access outside the run directory', async () => {
  const cacheRoot=join(home,'required-task-cache');
  await mkdir(join(home,'history-runs'),{recursive:true});
  for(const task of ['canopy-map','vault-seed']) {
    const allocation=writeRunDir(join(home,'history-runs'),'run_'+task,{serverUrl:'https://fixture.test',projectId:'project',runToken:'synthetic-token'});
    const checkout=await prepareWorkerCheckout({url,branch:'main',historyDepth:200},allocation.scratchDir,AbortSignal.timeout(15_000),async input=>
      input.commit === undefined ? {repository:{url,branch:'main',credential:GIT_READ_CREDENTIAL}}
        : {pin:{url,branch:'main',commit:input.commit}},
    {task,cacheRoot,gitPath,digests:task==='canopy-map'});
    try {
      const usedCache=existsSync(cacheRoot);
      const detachedRoot=await mkdtemp(join(tmpdir(),'myco-contained-history-'));
      const detached=join(detachedRoot,'run'),hiddenHome=home+'-history-hidden';
      let movedRun=false,movedHome=false;
      try {
        await rename(allocation.scratchDir,detached);movedRun=true;
        await rename(home,hiddenHome);movedHome=true;
        expect(existsSync(home)).toBe(false);
        const env={...process.env,HOME:detached,CODEX_HOME:detached,CLAUDE_CONFIG_DIR:detached,
          XDG_CONFIG_HOME:detached,MYCO_HOME:detached,TMPDIR:detached,
          GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
        const result=spawnSync('git',['-C',join(detached,'repo'),'log','--format=%H','HEAD'],{cwd:detached,env,encoding:'utf8'});
        expect({code:result.status,stderr:result.stderr,commits:result.stdout.trim().split('\n')}).toEqual({code:0,stderr:'',commits:[second,first]});
        expect(usedCache).toBe(false);
      } finally {
        if(movedHome)await rename(hiddenHome,home);
        if(movedRun)await rename(detached,allocation.scratchDir);
        await rm(detachedRoot,{recursive:true,force:true});
      }
      expect(existsSync(join(checkout.root,'.git/objects/info/alternates'))).toBe(false);
      expect(existsSync(join(checkout.root,'.git/commondir'))).toBe(false);
      expect(existsSync(cacheRoot)).toBe(false);
    } finally {await checkout.dispose();discardRunDir(allocation.scratchDir);}
  }
});
