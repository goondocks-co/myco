/**
 * One claims area per machine, whichever way a verb reaches its home (#1561 plan §6.3).
 *
 * `make dev-claim-prod` hands the `symbiont-config` claim to the released home (`~/.myco`). A verb the dogfood home
 * runs must then defer to it, also when the verb is reached through a pin that names the binary itself: no launch
 * script sets anything in its environment on that path. Both processes here run the CLI from source under a scratch
 * user home, with the machine pin (`~/.myco/runtime.home`) sending the second to the dogfood home, as on the owner's
 * Mac.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'entries', 'cli.ts');

function cli(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd, env: opts.env, encoding: 'utf-8', timeout: 60_000 });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('the symbiont-config claim, read from the dogfood home through the bare-binary pin', () => {
  it('names the released home as the owner, and refuses the dogfood home a claim it does not force', () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-claims-pin-'));
    const prod = path.join(userHome, '.myco');
    const dev = path.join(userHome, '.myco-dev');
    const project = path.join(userHome, 'repo');
    for (const dir of [prod, dev, path.join(project, '.myco')]) fs.mkdirSync(dir, { recursive: true });
    // The machine pin sends a process with no MYCO_HOME to the dogfood home; the project's pins name the binary and the home.
    fs.writeFileSync(path.join(prod, 'runtime.home'), `${dev}\n`, { mode: 0o644 });
    fs.writeFileSync(path.join(project, '.myco', 'runtime.home'), `${dev}\n`, { mode: 0o644 });
    fs.writeFileSync(path.join(project, '.myco', 'runtime.command'), `${process.execPath}\n`, { mode: 0o644 });
    const base: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, MYCO_TRAMPOLINED: '1' };
    delete base.MYCO_HOME;
    delete base.MYCO_CLAIMS_HOME;

    // `make dev-claim-prod`: the released home takes the claim.
    const claimed = cli(['subsystem', 'claim', 'symbiont-config', '--force'], { cwd: userHome, env: { ...base, MYCO_HOME: prod } });
    expect({ status: claimed.status, out: claimed.out }).toMatchObject({ status: 0 });
    expect(fs.existsSync(path.join(prod, 'claims', 'symbiont-config.json'))).toBe(true);

    // A verb from the repository, with nothing in its environment: it runs as the dogfood home and reads the one claims area.
    const listed = cli(['subsystem', 'list'], { cwd: project, env: base });
    expect(listed.out).toContain(`symbiont-config → ${prod}`);
    const refused = cli(['subsystem', 'claim', 'symbiont-config'], { cwd: project, env: base });
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(`already claimed by ${prod}`);
    // The dogfood home wrote no claims area of its own.
    expect(fs.existsSync(path.join(dev, 'claims'))).toBe(false);
    fs.rmSync(userHome, { recursive: true, force: true });
  }, 120_000);
});
