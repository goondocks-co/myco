import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

it('a pinned home reads global symbiont ownership from the machine’s shared claims area', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-claims-pin-'));
  try {
    const prod = path.join(root, '.myco');
    const dev = path.join(root, '.myco-dev');
    const project = path.join(root, 'repo');
    for (const dir of [prod, dev, path.join(project, '.myco')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(prod, 'runtime.home'), `${dev}\n`);
    const claims = new URL('../../packages/myco/src/member/subsystem-claim.ts', import.meta.url).href;
    const paths = new URL('../../packages/myco/src/paths/home.ts', import.meta.url).href;
    const env = sandboxChildEnv(root, { HOME: root, MYCO_HOME: prod });
    const run = (source: string) => spawnSync(process.execPath, ['--no-env-file', '--eval', source], { cwd: project, env, encoding: 'utf8', timeout: 15_000 });
    const claim = run(`const {claimSubsystem} = await import(${JSON.stringify(claims)}); claimSubsystem('symbiont-config', process.env.MYCO_HOME);`);
    expect(claim.status).toBe(0);
    const read = run(`delete process.env.MYCO_HOME; const {resolveMycoHome} = await import(${JSON.stringify(paths)}); const {readClaim,isClaimedByPeer,resolveClaimsHome} = await import(${JSON.stringify(claims)}); const home = resolveMycoHome(); console.log(JSON.stringify({home, claims:resolveClaimsHome(), owner:readClaim('symbiont-config')?.owner, peer:isClaimedByPeer('symbiont-config',home)}));`);
    expect(read.status).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual({ home: dev, claims: prod, owner: prod, peer: true });
    expect(fs.existsSync(path.join(dev, 'claims'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
