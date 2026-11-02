import { expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeArtifactCache } from '@myco/runtime/artifact-files.js';
import { placeExecutable } from '@myco/install/place-binary.js';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const SRC = path.resolve(import.meta.dir, '../../packages/myco/src');
const bytes = Buffer.from('embedded native artifact');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-artifacts-'));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'temp');
  fs.mkdirSync(home); fs.mkdirSync(temp);
  const originalHome = os.homedir;
  os.homedir = () => home;
  return { root, home, temp, dispose() { os.homedir = originalHome; fs.rmSync(root, {recursive:true, force:true}); } };
}

function runEnvironment(root: string, home: string, temp: string): void {
  const script = path.join(root, 'environment.ts');
  fs.writeFileSync(script, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { NativeArtifactCache } from ${JSON.stringify(path.join(SRC, 'runtime/artifact-files.ts'))};
import { placeExecutable } from ${JSON.stringify(path.join(SRC, 'install/place-binary.ts'))};
import { stageBinary, createBinaryUpdateDeps } from ${JSON.stringify(path.join(SRC, 'upgrade/apply-binary.ts'))};
import { prepareSourceGit } from ${JSON.stringify(path.join(SRC, 'runner/drivers/source-git.ts'))};
import { prepareRepositoryCheckout } from ${JSON.stringify(path.join(SRC, 'runner/repository-checkout.ts'))};
process.env.HOME = ${JSON.stringify(home)};
process.env.TMPDIR = ${JSON.stringify(temp)};
process.umask(0o002);
const program = '#!/bin/sh\\necho 2.0.0\\n';
const source = path.join(process.env.HOME, 'source');
fs.writeFileSync(source, program, {mode:0o755});
const bin = path.join(process.env.HOME, 'bin', 'myco');
placeExecutable(source, bin, {ready:file=>{assert.equal(fs.statSync(path.dirname(file)).mode & 0o777,0o700);return {runs:true};}});
assert.equal(execFileSync(bin, ['--version'], {encoding:'utf8'}).trim(), '2.0.0');
const deps = createBinaryUpdateDeps({fetch: async url => new Response(String(url).endsWith('sums') ? createHash('sha256').update(program).digest('hex')+'  myco-linux-x64\\n' : program)});
const staged = await stageBinary({home:process.env.HOME, platform:'linux', refs:{assetUrl:'https://fake.invalid/binary',sha256sumsUrl:'https://fake.invalid/sums',assetName:'myco-linux-x64',targetVersion:'2.0.0'}},deps);
assert.equal('error' in staged ? staged.error : staged.version, '2.0.0');
const run = path.join(process.env.HOME, 'run');
const repo = path.join(run, 'repo');
fs.mkdirSync(repo, {recursive:true});
execFileSync('git',['init','--quiet',repo]);
const grant = prepareSourceGit(run);
assert.ok(grant);
execFileSync(path.join(grant.shimDir,'git'),['-C','repo','ls-files'],{cwd:run,env:{...process.env,...grant.env}});
const fakeGit=path.join(process.env.HOME,'fake-git');
fs.writeFileSync(fakeGit, '#!/bin/sh\\ncase "$*" in *rev-parse*) echo '+ 'a'.repeat(40)+';; esac\\n', {mode:0o700});
const checkout = await prepareRepositoryCheckout({url:'https://fake.invalid/repo',branch:'main',gitPath:fakeGit,pin:async sha=>sha,signal:new AbortController().signal});
assert.ok(checkout.root.startsWith(process.env.TMPDIR));
await checkout.dispose();
const cache=new NativeArtifactCache('environment');
assert.ok(cache.directory.startsWith(fs.realpathSync(process.env.HOME)));
cache.materialize('native',Buffer.from('embedded'));
const {Database}=await import('bun:sqlite');
const native=await import(${JSON.stringify(path.join(SRC, 'runtime/native-deps.ts'))});
const embeds=['sqlite','vec','rg'].map(name=>{const file=path.join(process.env.HOME,name);fs.writeFileSync(file,'embedded '+name);return file;});
Database.setCustomSQLite=file=>{assert.ok(file.startsWith(cache.directory.slice(0,cache.directory.lastIndexOf(path.sep))));assert.equal(fs.readFileSync(file,'utf8'),'embedded sqlite');};
await native.registerEmbeddedNativeDeps({version:'wired',libsqliteEmbed:embeds[0],vec0Embed:embeds[1],ripgrepEmbed:embeds[2]});
for(const [file,expected] of [[native.getLibsqlitePath(),'embedded sqlite'],[native.getVec0Path(),'embedded vec'],[native.getRipgrepPath(),'embedded rg']]){assert.ok(file.startsWith(fs.realpathSync(process.env.HOME)));assert.equal(fs.readFileSync(file,'utf8'),expected);}

assert.equal(fs.statSync(fs.realpathSync(process.env.HOME)).mode & 0o777,0o775);
assert.equal(os.tmpdir(),process.env.TMPDIR);
console.log('install, update, source, checkout and cache passed');
`);
  const child = spawnSync(process.execPath, ['--no-env-file', script], {cwd:root, env:sandboxChildEnv(root,{HOME:home,TMPDIR:temp}),encoding:'utf8',timeout:30_000});
  expect({status:child.status,stderr:child.stderr}).toEqual({status:0,stderr:''});
  expect(child.stdout.trim()).toBe('install, update, source, checkout and cache passed');
}

it.skipIf(process.platform === 'win32')('installs, updates and prepares source on a 0775 home with umask 002', () => {
  const f = fixture();
  try { fs.chmodSync(f.home,0o775); runEnvironment(f.root,f.home,f.temp); }
  finally { f.dispose(); }
}, 30_000);

it.skipIf(process.platform === 'win32')('accepts raw symlinked home and temp paths for native cache and runner operations', () => {
  const f = fixture();
  try {
    fs.chmodSync(f.home,0o775);
    const home=path.join(f.root,'home-link'), temp=path.join(f.root,'temp-link');
    fs.symlinkSync(f.home,home); fs.symlinkSync(f.temp,temp);
    runEnvironment(f.root,home,temp);
  } finally { f.dispose(); }
}, 30_000);

it.skipIf(process.platform === 'win32')('refuses foreign-owned and symlink cache leaves before changing them', () => {
  const f=fixture();
  try {
    const cache=new NativeArtifactCache('trust');
    fs.chmodSync(cache.directory,0o755);
    if (typeof process.getuid === 'function') {
      const lstat=fs.lstatSync;
      const foreignPath=(file:string)=>spyOn(fs,'lstatSync').mockImplementation(new Proxy(lstat,{apply(target,receiver,args){const stat=Reflect.apply(target,receiver,args);if(String(args[0])===file)Object.defineProperty(stat,'uid',{value:process.getuid!()+1});return stat;}}));
      const foreign=foreignPath(cache.directory);
      try { expect(()=>new NativeArtifactCache('trust')).toThrow('foreign-owned'); }
      finally {foreign.mockRestore();}
      expect(fs.statSync(cache.directory).mode & 0o777).toBe(0o755);
      const file=cache.materialize('native',bytes); const foreignFile=foreignPath(file);
      try {expect(()=>cache.materialize('native',bytes)).toThrow('foreign-owned');}
      finally {foreignFile.mockRestore();}
    }
    fs.rmSync(cache.directory,{recursive:true});
    fs.symlinkSync(f.temp,cache.directory,'dir');
    expect(()=>new NativeArtifactCache('trust')).toThrow('real directory');
  } finally {f.dispose();}
});

it('tightens its owned leaves and repairs wrong or interrupted bytes atomically before reuse', () => {
  const f=fixture();
  try {
    const cache=new NativeArtifactCache('bytes');
    fs.chmodSync(path.dirname(cache.directory),0o775); fs.chmodSync(cache.directory,0o755);
    const admitted=new NativeArtifactCache('bytes');
    if(process.platform!=='win32')for(const directory of [cache.directory,path.dirname(cache.directory)]) expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    const file=admitted.materialize('vec0',bytes);
    for(const wrong of [bytes.subarray(0,5),Buffer.alloc(bytes.length)]) {
      fs.writeFileSync(file,wrong);
      const before=fs.statSync(file).ino;
      expect(admitted.materialize('vec0',bytes)).toBe(file);
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(fs.statSync(file).ino).not.toBe(before);
    }
    const rename=spyOn(fs,'renameSync');
    try { expect(admitted.materialize('vec0',bytes)).toBe(file); expect(rename).not.toHaveBeenCalled(); }
    finally {rename.mockRestore();}
    if(process.platform!=='win32') {
      fs.unlinkSync(file); fs.symlinkSync(path.join(f.root,'outside'),file);
      expect(()=>admitted.materialize('vec0',bytes)).toThrow('regular file');
    }
  } finally {f.dispose();}
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('falls back through raw symlinked temp with a read-only or missing home', () => {
  const f=fixture();
  try {
    fs.chmodSync(f.home,0o500);
    const temp=path.join(f.root,'temp-link'); fs.symlinkSync(f.temp,temp);
    const script=path.join(f.root,'readonly.ts');
    fs.writeFileSync(script, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NativeArtifactCache} from ${JSON.stringify(path.join(SRC,'runtime/artifact-files.ts'))};
const paths=[];
for(const version of ['readonly','missing']) {
  const cache=new NativeArtifactCache(version); paths.push(cache.directory);
  assert.ok(cache.directory.startsWith(fs.realpathSync(process.env.TMPDIR)+path.sep));
  assert.equal(fs.statSync(cache.directory).mode & 0o777,0o700);
  assert.equal(fs.readFileSync(cache.materialize('native',Buffer.from('embedded')),'utf8'),'embedded');
  if(version==='readonly') {
    fs.chmodSync(process.env.HOME,0o700);
    const late=new NativeArtifactCache('readonly-version'); const persistent=late.directory;
    fs.chmodSync(persistent,0o500);
    assert.equal(fs.readFileSync(late.materialize('native',Buffer.from('embedded')),'utf8'),'embedded');
    assert.ok(late.directory.startsWith(fs.realpathSync(process.env.TMPDIR)+path.sep)); paths.push(late.directory);
    fs.chmodSync(persistent,0o700); fs.rmSync(process.env.HOME,{recursive:true,force:true});
  }
}
assert.equal(new Set(paths).size,paths.length);
assert.equal(os.tmpdir(),process.env.TMPDIR);
for(const file of paths)fs.rmSync(file,{recursive:true,force:true});
`);
    const child=spawnSync(process.execPath,['--no-env-file',script],{cwd:f.root,env:sandboxChildEnv(f.root,{HOME:f.home,TMPDIR:temp}),encoding:'utf8',timeout:15_000});
    expect({status:child.status,stderr:child.stderr}).toEqual({status:0,stderr:''});
  } finally {if(fs.existsSync(f.home))fs.chmodSync(f.home,0o700);f.dispose();}
});

it('accepts a verified concurrent publisher after EPERM or EBUSY and tolerates unsupported directory fsync', () => {
  const f=fixture();
  try {
    const cache=new NativeArtifactCache('race');
    for(const code of ['EPERM','EBUSY']) {
      const rename=spyOn(fs,'renameSync').mockImplementation((source,target)=>{fs.copyFileSync(source,target);throw Object.assign(new Error(code),{code});});
      try {expect(fs.readFileSync(cache.materialize(code,bytes))).toEqual(bytes);}
      finally {rename.mockRestore();}
    }
    const rejected=spyOn(fs,'renameSync').mockImplementation((_source,target)=>{fs.writeFileSync(target,'wrong');throw Object.assign(new Error('EPERM'),{code:'EPERM'});});
    try {expect(()=>cache.materialize('wrong-race',bytes)).toThrow('EPERM');}
    finally {rejected.mockRestore();}
    const fsync=fs.fsyncSync;
    const unsupported=spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('directory sync unsupported'),{code:'EINVAL'});fsync(fd);});
    try {
      expect(fs.readFileSync(cache.materialize('sync',bytes))).toEqual(bytes);
      const source=path.join(f.root,'source'), destination=path.join(f.home,'bin','myco');
      fs.writeFileSync(source,bytes); placeExecutable(source,destination);
      expect(fs.readFileSync(destination)).toEqual(bytes);
    } finally {unsupported.mockRestore();}
  } finally {f.dispose();}
});
