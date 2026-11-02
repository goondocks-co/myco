import { expect, it } from 'bun:test';
import ts from 'typescript-v6';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { spoolDirFor } from '@myco/member/spool.js';

const REPO = path.resolve(import.meta.dir, '../..');
const DISPATCH = path.join(REPO, 'packages/myco/src/entries/dispatch.ts');
const CLI = path.join(REPO, 'packages/myco/src/cli.ts');
const BUILD = path.join(REPO, 'packages/myco/scripts/build-single-target.mjs');
const TRUSTED_SERVER = 'https://trusted.invalid';
const CHECKOUT_SERVER = 'https://checkout.invalid';
const TRUSTED_PROJECT = 'proj_trusted';

it('checkout .env cannot choose a hook home or Deployment; inherited credentials still work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-checkout-env-'));
  try {
    const checkout = path.join(root, 'checkout');
    const home = path.join(root, 'home');
    const trustedHome = path.join(home, '.myco');
    const checkoutHome = path.join(root, 'checkout-home');
    fs.mkdirSync(checkout);
    fs.mkdirSync(home);
    for (const [mycoHome, serverUrl, projectId] of [
      [trustedHome, TRUSTED_SERVER, TRUSTED_PROJECT],
      [checkoutHome, CHECKOUT_SERVER, 'proj_checkout'],
    ]) writeRegistryEntry({ version: REGISTRY_VERSION, root: checkout, serverUrl, projectId,
      token: `fake-${projectId}`, machineId: 'machine_env', joinedAt: Date.now(), updatedAt: Date.now(),
    }, { mycoHome });
    fs.writeFileSync(path.join(checkout, '.env'), [
      `MYCO_HOME=${checkoutHome}`, `MYCO_SERVER_URL=${CHECKOUT_SERVER}`,
      'MYCO_PROJECT=proj_checkout', 'MYCO_MEMBER_TOKEN=fake-checkout-token', 'MYCO_AGENT_SESSION=1',
    ].join('\n'));
    const requests = path.join(root, 'requests.jsonl');
    const preload = path.join(root, 'preload.ts');
    fs.writeFileSync(preload, `import fs from 'node:fs';
delete process.env.MYCO_HOME;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({url:request.url, authorization:request.headers.get('authorization')})+'\\n');
  return new Response('{}', {status:503});
};
`);
    const entry = path.join(root, 'entry.ts');
    fs.writeFileSync(entry, `import './preload.ts';\nimport { dispatch } from ${JSON.stringify(DISPATCH)};\nawait dispatch(async () => { throw new Error('a hook must not load native dependencies'); });\n`);
    const temporary = path.join(root, 'tmp');
    fs.mkdirSync(temporary);
    const env = sandboxChildEnv(root, { HOME: home, MYCO_HOME: trustedHome, TMPDIR:temporary });
    for (const key of ['MYCO_SERVER_URL', 'MYCO_PROJECT', 'MYCO_MEMBER_TOKEN', 'MYCO_JOIN_CODE', 'MYCO_AGENT_SESSION']) delete env[key];
    const args = ['hook', 'session-end', '--symbiont', 'claude-code', '--ship', 'inline'];
    const input = JSON.stringify({session_id:'session_env', cwd:checkout, hook_event_name:'SessionEnd'});
    const run = (command: string[], credential: 'registry' | 'env', inherited = false) => {
      fs.rmSync(requests, { force: true });
      const result = spawnSync(command[0], [...command.slice(1), ...args, '--credential', credential], {
        cwd: checkout, input, encoding: 'utf8', timeout: 15_000,
        env: {...env, ...(inherited ? { MYCO_SERVER_URL: TRUSTED_SERVER, MYCO_PROJECT: TRUSTED_PROJECT, MYCO_MEMBER_TOKEN:'fake-inherited-token' } : {})},
      });
      expect({ status:result.status, signal:result.signal, error:result.error?.message, stderr:result.stderr }).toEqual({ status:0, signal:null, error:undefined, stderr:result.stderr });
      return fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    };
    const source = [process.execPath, '--no-env-file', entry];
    const registryRequests = run(source, 'registry');
    expect(registryRequests.length).toBeGreaterThan(0);
    expect(registryRequests.every(request => request.url.startsWith(TRUSTED_SERVER + '/'))).toBe(true);
    expect(fs.existsSync(spoolDirFor({ serverUrl:TRUSTED_SERVER, projectId:TRUSTED_PROJECT }, trustedHome))).toBe(true);
    expect(fs.existsSync(path.join(checkoutHome, 'member', 'spool'))).toBe(false);
    expect(run(source, 'env')).toEqual([]);
    const inheritedRequests = run(source, 'env', true);
    expect(inheritedRequests.length).toBeGreaterThan(0);
    expect(inheritedRequests.every(request => request.authorization === 'Bearer fake-inherited-token')).toBe(true);

    const build = fs.readFileSync(BUILD, 'utf8');
    const syntax = ts.createSourceFile(BUILD, build, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let flags: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'spawnSync') {
        const [command, argv] = node.arguments;
        if (command && ts.isStringLiteral(command) && command.text === 'bun' && argv && ts.isArrayLiteralExpression(argv)) {
          flags = argv.elements.filter(ts.isStringLiteral).map(element => element.text).filter(flag => flag.startsWith('--no-compile-autoload-'));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    expect(flags).toEqual(['--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig']);
    const binary = path.join(root, process.platform === 'win32' ? 'hook.exe' : 'hook');
    const compiled = spawnSync(process.execPath, ['build', '--compile', '--splitting', ...flags,
      '--external', '../cli.js', entry, '--outfile', binary],
      { cwd:root, env, encoding:'utf8', timeout:60_000 });
    expect({status:compiled.status, stderr:compiled.stderr}).toEqual({status:0, stderr:compiled.stderr});
    if (process.platform === 'darwin') {
      const signed = spawnSync('codesign', ['--force', '--sign', '-', binary], {env, encoding:'utf8'});
      expect({status:signed.status, stderr:signed.stderr}).toEqual({status:0, stderr:signed.stderr});
    }
    fs.writeFileSync(path.join(checkout, 'bunfig.toml'), 'preload = ["./checkout-preload.ts"]\n');
    fs.writeFileSync(path.join(checkout, 'checkout-preload.ts'), `process.env.MYCO_HOME=${JSON.stringify(checkoutHome)};\n`);
    const compiledRequests = run([binary], 'registry');
    expect(compiledRequests.length).toBeGreaterThan(0);
    expect(compiledRequests.every(request => request.url.startsWith(TRUSTED_SERVER + '/'))).toBe(true);
    expect(fs.existsSync(path.join(checkoutHome, 'member', 'spool'))).toBe(false);
    expect(run([binary], 'env')).toEqual([]);
    fs.unlinkSync(path.join(checkout, 'bunfig.toml'));

    const admin = spawnSync(process.execPath, ['--no-env-file', '--preload', preload, '--eval', `process.argv=['bun',${JSON.stringify(CLI)},'version']; await import(${JSON.stringify(CLI)}); console.log('ENV '+JSON.stringify({home:process.env.MYCO_HOME,server:process.env.MYCO_SERVER_URL}));`],
      {cwd:checkout, env, encoding:'utf8', timeout:15_000});
    expect({status:admin.status, stderr:admin.stderr}).toEqual({status:0, stderr:''});
    expect(admin.stdout.split('\n').find(line => line.startsWith('ENV '))).toBe('ENV {}');
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
}, 60_000);
