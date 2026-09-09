/**
 * The Cloudflare lifecycle, asserted by the argv it produces and the record it
 * writes. A fake runner scripts wrangler's answers; nothing here provisions
 * real infrastructure.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudflareDeploymentStatus,
  createCloudflareDeployment,
  rollbackCloudflareDeployment,
  destroyCloudflareDeployment,
  updateCloudflareDeployment,
  DEPLOY_CONFIG_NAME,
} from '@myco/server/cloudflare-lifecycle.js';
import { stagingDir, stagingRoot, WORKER_ENTRY } from '@myco/server/cloudflare-stage.js';
import { readDeploymentRecord, writeDeploymentRecord, WranglerAbsent, WranglerNotSignedIn } from '@myco/server/cloudflare.js';
import { BUNDLED_WORKER_WRANGLER } from '@myco/worker-bundle.generated.js';
import { VECTOR_INDEX_DIMENSIONS, VECTOR_INDEX_NAME, VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';
import type { CommandRunner, CommandResult } from '@myco/server/runner.js';

const ACCOUNT = 'a'.repeat(32);
const DB_ID = '11111111-2222-4333-8444-555555555555';
const STORE = 'f'.repeat(32);

let calls: { args: string[]; input?: string; cwd?: string; cwdOnDisk: boolean | null }[] = [];

/** Answers each wrangler subcommand the way the real one does; the account's state accumulates across calls like the real one's. */
const buckets = new Set<string>();
const runner = (over: Record<string, Partial<CommandResult>> = {}): CommandRunner => ({
  async run(_command, args, options) {
    const opts = options as { input?: string; cwd?: string } | undefined;
    // Answered at spawn time, not afterwards: a directory a later step creates
    // is not a directory this command could run in.
    calls.push({ args: [...args], input: opts?.input, cwd: opts?.cwd, cwdOnDisk: opts?.cwd === undefined ? null : existsSync(opts.cwd) });
    const flat = args.join(' ');
    if (flat.includes('r2 bucket create')) {
      const name = args[args.indexOf('create') + 1]!;
      if (buckets.has(name)) return { code: 1, stdout: '', stderr: `A bucket with the name ${name} already exists` };
      buckets.add(name);
      return { code: 0, stdout: `Created bucket ${name}`, stderr: '' };
    }
    const canned: Record<string, Partial<CommandResult>> = {
      'vectorize list --json': { stdout: '[{"name":"myco-server-memory"}]' },
      'vectorize get myco-server-memory --json': { stdout: '{"config":{"dimensions":1536,"metric":"cosine"}}' },
      'vectorize list-metadata-index': { stdout: '[{"propertyName":"type","indexType":"String"},{"propertyName":"status","indexType":"String"},{"propertyName":"session_id","indexType":"String"},{"propertyName":"created_at","indexType":"Number"},{"propertyName":"observation_type","indexType":"String"},{"propertyName":"release_state","indexType":"String"},{"propertyName":"release_confidence","indexType":"String"}]' },
      'd1 list --json': { stdout: '[]' },
      'd1 create myco-server': { stdout: `database_id = "${DB_ID}"` },
      'd1 execute': { stdout: '[\n  {\n    "results": [],\n    "success": true\n  }\n]' },
      'secrets-store store list': { stdout: '', code: 0 },
      'secrets-store store create': { stdout: `Created store myco (${STORE})` },
      'deploy -c wrangler.deploy.toml': { stdout: 'Current Version ID: 16a2423e-af96-4310-b61b-4e2b5fd1310b\n' },
      ...over,
    };
    const match = Object.entries(canned).find(([k]) => flat.includes(k));
    return { code: 0, stdout: '', stderr: '', ...(match?.[1] ?? {}) };
  },
});
beforeEach(() => { calls = []; buckets.clear(); });

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'myco-cf-life-'));
  return { home, dir: stagingDir(home), options: { accountId: ACCOUNT, mycoHome: home } };
};

/** A home no command has touched: `stagingDir` is a path answer, so naming it writes nothing. */
const freshHome = (): string => mkdtempSync(join(tmpdir(), 'myco-cf-fresh-'));

/** Drives the CLI, capturing what it says and whether it exited. */
const drive = async (argv: string[]): Promise<{ exited: boolean; said: string; printed: string }> => {
  const said: string[] = [];
  const printed: string[] = [];
  const error = console.error;
  const log = console.log;
  const exit = process.exit;
  console.error = (line: unknown) => { said.push(String(line)); };
  console.log = (line: unknown) => { printed.push(String(line)); };
  process.exit = ((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as typeof process.exit;
  try {
    const { run } = await import('@myco/cli/server.js');
    await run(argv);
    return { exited: false, said: said.join('\n'), printed: printed.join('\n') };
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('exit ')) throw err;
    return { exited: true, said: said.join('\n'), printed: printed.join('\n') };
  } finally {
    console.error = error;
    console.log = log;
    process.exit = exit;
  }
};

/** Every lifecycle verb, by name, driven against one home. */
const EVERY_VERB: ReadonlyArray<{ verb: string; run: (options: { accountId: string; mycoHome: string }, r: CommandRunner) => Promise<unknown> }> = [
  { verb: 'create', run: (o, runner) => createCloudflareDeployment({ ...o, runner }) },
  { verb: 'update', run: (o, runner) => updateCloudflareDeployment({ ...o, runner }) },
  { verb: 'status', run: (o, runner) => cloudflareDeploymentStatus({ ...o, runner }) },
  { verb: 'rollback', run: (o, runner) => rollbackCloudflareDeployment({ ...o, runner, versionId: 'a'.repeat(8) }) },
  { verb: 'destroy', run: (o, runner) => destroyCloudflareDeployment({ ...o, runner }) },
];

/** The record the verbs that read one need, written into a home. */
const recordFor = (home: string): void => {
  writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: 'old-version', deployedAt: 'then', databaseId: DB_ID, storeId: STORE }, home);
};

describe('create', () => {
  it('provisions, writes the record before deploying, renders the config, migrates before the deploy, and records the version', async () => {
    const { home, dir, options } = setup();
    const result = await createCloudflareDeployment({ ...options, runner: runner() });

    expect(result.createdResources).toEqual(['d1 myco-server', 'r2 myco-server-blobs', 'secrets store', 'store secret myco-secret-wrap-key', 'worker secret SESSION_SECRET']);
    const record = readDeploymentRecord(home)!;
    expect({ db: record.databaseId, store: record.storeId, version: record.versionId }).toEqual({ db: DB_ID, store: STORE, version: '16a2423e-af96-4310-b61b-4e2b5fd1310b' });

    const rendered = readFileSync(join(dir, DEPLOY_CONFIG_NAME), 'utf8');
    expect(rendered).toContain(`database_id = "${DB_ID}"`);
    expect(rendered).toContain(`store_id = "${STORE}"`);

    // Everything a deploy reads is staged from what the binary carries: no
    // checkout is consulted and nothing is built on the operator's machine.
    expect(existsSync(join(dir, WORKER_ENTRY))).toBe(true);
    expect(existsSync(join(dir, 'ui', 'dist', 'index.html'))).toBe(true);
    expect(readdirSync(join(dir, 'migrations')).length).toBe(renderMigrationFiles().length);

    const flat = calls.map((c) => c.args.join(' '));
    const migrateAt = flat.findIndex((a) => a.includes('migrations apply'));
    const deployAt = flat.findIndex((a) => /(^|\s)deploy(\s|$)/.test(a) && a.includes(DEPLOY_CONFIG_NAME));
    const secretAt = flat.findIndex((a) => a.includes('secret put SESSION_SECRET'));
    expect({ migrateAt: migrateAt >= 0, deployAt: deployAt >= 0, order: migrateAt < deployAt, secretAfterDeploy: secretAt > deployAt }).toEqual({ migrateAt: true, deployAt: true, order: true, secretAfterDeploy: true });
    expect(flat[migrateAt]).toContain(DEPLOY_CONFIG_NAME);

    // The absence the issue asks for: nothing on this machine builds, and no
    // command reaches a container runtime or a checkout.
    for (const forbidden of ['containers build', 'run build:ui', 'run harness:bundle', 'docker']) {
      expect({ forbidden, ran: flat.some((a) => a.includes(forbidden)) }).toEqual({ forbidden, ran: false });
    }
  });

  it('GATE: a deploy failure leaves the record on disk naming what exists', async () => {
    const { home, options } = setup();
    const failing = runner({ 'deploy -c wrangler.deploy.toml': { code: 1, stderr: 'build failed' } });
    await expect(createCloudflareDeployment({ ...options, runner: failing })).rejects.toThrow();
    const record = readDeploymentRecord(home)!;
    expect({ db: record.databaseId, store: record.storeId }).toEqual({ db: DB_ID, store: STORE });
  });

  it('GATE: every verb runs every command in a directory this binary owns, never the one the operator stands in', async () => {
    // Wrangler walks UP from its working directory looking for a config, so a
    // command run from wherever the operator happens to be can pick up a
    // checkout's wrangler.toml — the second config source staging removes. Each
    // verb is driven, because a verb that skips `bareCommand` is exactly the
    // way this comes back.
    const { home, dir, options } = setup();
    const root = stagingRoot(home);

    /** Every command recorded since the last check ran where the binary put it. */
    const ranWhereOwned = (verb: string): void => {
      expect({ verb, ran: calls.length > 0 }).toEqual({ verb, ran: true });
      for (const call of calls) {
        const where = call.cwd ?? '';
        expect({ verb, args: call.args.join(' '), owned: where === dir || where === root, cwd: where === process.cwd() ? 'the operator\'s' : 'owned' })
          .toEqual({ verb, args: call.args.join(' '), owned: true, cwd: 'owned' });
      }
      // Every command reading a config reads the staged one.
      for (const call of calls.filter((c) => c.args.includes('-c'))) {
        expect({ verb, args: call.args.join(' '), cwd: call.cwd }).toEqual({ verb, args: call.args.join(' '), cwd: dir });
      }
      calls = [];
    };

    await createCloudflareDeployment({ ...options, runner: runner() });
    ranWhereOwned('create');

    await updateCloudflareDeployment({ ...options, runner: runner() });
    ranWhereOwned('update');

    await cloudflareDeploymentStatus({ ...options, runner: runner() });
    ranWhereOwned('status');

    await rollbackCloudflareDeployment({ ...options, runner: runner(), versionId: 'a'.repeat(8) });
    ranWhereOwned('rollback');

    await destroyCloudflareDeployment({ ...options, runner: runner() });
    ranWhereOwned('destroy');
  });

  it('puts the Deployment on the domain the operator named, in the record and in the config it deploys', async () => {
    const { home, dir, options } = setup();
    await createCloudflareDeployment({ ...options, runner: runner(), url: 'https://myco.example.com' });
    expect(readDeploymentRecord(home)!.url).toBe('https://myco.example.com');
    const rendered = readFileSync(join(dir, DEPLOY_CONFIG_NAME), 'utf8');
    expect(rendered).toContain('routes = [ { pattern = "myco.example.com", custom_domain = true } ]');
    expect(rendered).toContain('MYCO_ORIGIN = "https://myco.example.com"');
  });

  it('GATE: secrets travel on stdin, never argv', async () => {
    const { options } = setup();
    await createCloudflareDeployment({ ...options, runner: runner() });
    const secretCalls = calls.filter((c) => c.args.join(' ').includes('secrets-store secret create') || c.args.join(' ').includes('secret put'));
    expect(secretCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of secretCalls) {
      expect(typeof call.input).toBe('string');
      expect(call.args.join(' ')).not.toContain(call.input!);
    }
  });

  it('is idempotent: an existing record keeps its ids, and a re-run creates no second SESSION_SECRET', async () => {
    const { home, options } = setup();
    await createCloudflareDeployment({ ...options, runner: runner() });
    calls = [];
    const again = await createCloudflareDeployment({ ...options, runner: runner() });
    expect(again.createdResources).toEqual([]);
    expect(readDeploymentRecord(home)!.databaseId).toBe(DB_ID);
    expect(calls.some((c) => c.args.join(' ').includes('d1 create'))).toBe(false);
    expect(calls.some((c) => c.args.join(' ').includes('secret put SESSION_SECRET'))).toBe(false);
  });
});

describe('update', () => {
  it('refuses without a record, and with one migrates then deploys through the rendered config', async () => {
    const { home, dir, options } = setup();
    await expect(updateCloudflareDeployment({ ...options, runner: runner() })).rejects.toThrow(/no Cloudflare deployment record/);
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then', databaseId: DB_ID, storeId: STORE }, home);
    const updated = await updateCloudflareDeployment({ ...options, runner: runner() });
    expect(updated.versionId).toBe('16a2423e-af96-4310-b61b-4e2b5fd1310b');
    expect(existsSync(join(dir, DEPLOY_CONFIG_NAME))).toBe(true);
    expect(readDeploymentRecord(home)!.versionId).toBe('16a2423e-af96-4310-b61b-4e2b5fd1310b');
  });
});

describe('destroy', () => {
  it('GATE: removes only the Worker and names everything it kept', async () => {
    const { home, options } = setup();
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then', databaseId: DB_ID }, home);
    const destroyed = await destroyCloudflareDeployment({ ...options, runner: runner() });
    expect(destroyed.kept.join(' ')).toMatch(/d1 .* r2 .*secrets store.*record/);
    expect(destroyed.kept).toContain('vectorize myco-server-memory');
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat.some((a) => a.includes('delete --name myco-server'))).toBe(true);
    expect(flat.some((a) => a.includes('d1 delete') || a.includes('bucket delete'))).toBe(false);
    expect(readDeploymentRecord(home)).not.toBeNull();
  });
});

describe('rollback', () => {
  const VERSION = '99999999-8888-4777-8666-555555555555';

  it('rolls the Worker back to the named version through wrangler and re-stamps the record', async () => {
    const { home, options } = setup();
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: 'old-version', deployedAt: 'then', databaseId: DB_ID }, home);
    const rolled = await rollbackCloudflareDeployment({ ...options, runner: runner(), versionId: VERSION, message: 'smoke failed' });
    expect(rolled.versionId).toBe(VERSION);
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat.some((a) => a.includes(`rollback ${VERSION} --name myco-server -y -m smoke failed`))).toBe(true);
    expect(readDeploymentRecord(home)!.versionId).toBe(VERSION);
  });

  it('defaults to the record version, and refuses when neither the flag nor the record names one', async () => {
    const { home, options } = setup();
    await expect(rollbackCloudflareDeployment({ ...options, runner: runner() })).rejects.toThrow(/no Cloudflare deployment record/);
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then', databaseId: DB_ID }, home);
    await expect(rollbackCloudflareDeployment({ ...options, runner: runner() })).rejects.toThrow(/no version to roll back to/);
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: VERSION, deployedAt: 'then', databaseId: DB_ID }, home);
    const rolled = await rollbackCloudflareDeployment({ ...options, runner: runner() });
    expect(rolled.versionId).toBe(VERSION);
    expect(calls.some((c) => c.args.join(' ').includes('rollback ' + VERSION))).toBe(true);
  });
});

/**
 * What the first Cloudflare command on a machine meets before it does anything.
 *
 * A fresh machine has no staging directory and may have no wrangler and no
 * Cloudflare login, and each of those has a way of arriving as something else:
 * a missing working directory as `ENOENT` against `npx`, a missing wrangler as
 * a version `npx` fetches, a missing login as wrangler's own message about an
 * environment variable. Every gate here drives ALL FIVE verbs, because a verb
 * that skips the preflight is exactly how this comes back.
 */
describe('the prerequisites every verb checks first', () => {
  it('GATE: every command spawns into a directory that is on disk', async () => {
    for (const { verb, run } of EVERY_VERB) {
      calls = [];
      const home = freshHome();
      // `create` starts from nothing at all; the verbs that read a record get
      // one, and writing it is itself the only thing that has touched the home.
      if (verb !== 'create') recordFor(home);
      await run({ accountId: ACCOUNT, mycoHome: home }, runner());
      expect({ verb, ran: calls.length > 0 }).toEqual({ verb, ran: true });
      for (const call of calls) {
        expect({ verb, args: call.args.join(' '), cwdOnDisk: call.cwdOnDisk })
          .toEqual({ verb, args: call.args.join(' '), cwdOnDisk: true });
      }
    }
  });

  it('GATE: every npx invocation leads with --no-install, so no verb can fetch a wrangler', async () => {
    for (const { verb, run } of EVERY_VERB) {
      calls = [];
      const home = freshHome();
      if (verb !== 'create') recordFor(home);
      await run({ accountId: ACCOUNT, mycoHome: home }, runner());
      expect({ verb, ran: calls.length > 0 }).toEqual({ verb, ran: true });
      for (const call of calls) {
        expect({ verb, args: call.args.join(' '), leads: call.args[0] })
          .toEqual({ verb, args: call.args.join(' '), leads: '--no-install' });
      }
    }
  });

  it('GATE: with no wrangler installed, every verb refuses by name and runs nothing else', async () => {
    const absent = () => runner({ 'wrangler --version': { code: 1, stderr: 'npx: command not found: wrangler' } });
    for (const { verb, run } of EVERY_VERB) {
      calls = [];
      const home = freshHome();
      if (verb !== 'create') recordFor(home);
      await expect(run({ accountId: ACCOUNT, mycoHome: home }, absent())).rejects.toThrow(WranglerAbsent);
      expect({ verb, calls: calls.map((c) => c.args.join(' ')) })
        .toEqual({ verb, calls: ['--no-install wrangler --version'] });
    }
  });

  it('GATE: with wrangler signed in to nothing, every verb refuses by name and runs nothing else', async () => {
    const held = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      const anonymous = () => runner({ 'wrangler whoami': { code: 1, stderr: 'not authenticated' } });
      for (const { verb, run } of EVERY_VERB) {
        calls = [];
        const home = freshHome();
        if (verb !== 'create') recordFor(home);
        await expect(run({ accountId: ACCOUNT, mycoHome: home }, anonymous())).rejects.toThrow(WranglerNotSignedIn);
        expect({ verb, calls: calls.map((c) => c.args.join(' ')) })
          .toEqual({ verb, calls: ['--no-install wrangler --version', '--no-install wrangler whoami'] });
      }
    } finally {
      if (held === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = held;
    }
  });

  it('takes an API token in the environment as the identity, and asks whoami nothing', async () => {
    const held = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = 'a-token';
    try {
      const home = freshHome();
      recordFor(home);
      await cloudflareDeploymentStatus({ accountId: ACCOUNT, mycoHome: home, runner: runner({ 'wrangler whoami': { code: 1 } }) });
      expect(calls.some((c) => c.args.includes('whoami'))).toBe(false);
    } finally {
      if (held === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = held;
    }
  });

  it('says so when the installed wrangler is a major version from the one the carried Worker was built with', async () => {
    const home = freshHome();
    recordFor(home);
    const said: string[] = [];
    await cloudflareDeploymentStatus({
      accountId: ACCOUNT,
      mycoHome: home,
      report: (line) => { said.push(line); },
      runner: runner({ 'wrangler --version': { stdout: ' ⛅️ wrangler 3.0.0\n' } }),
    });
    expect(said.join('\n')).toContain('3.0.0');
    expect(said.join('\n')).toContain(BUNDLED_WORKER_WRANGLER);
  });
});

/**
 * The two flags that no longer apply to this target. A flag silently ignored is
 * a flag an operator believes did something; both are refused by name and the
 * verb is driven to prove it, rather than the help text being read back.
 */
describe('the flags this target refuses by name', () => {
  it('refuses --dir, naming what carries the deploy instead', async () => {
    const refused = await drive(['create', '--target', 'cloudflare', '--account-id', ACCOUNT, '--dir', '/some/checkout']);
    expect({ exited: refused.exited, names: /--dir is not a flag for this target/.test(refused.said) }).toEqual({ exited: true, names: true });
    expect(refused.said).toContain('travel in this binary');
  });

  it('refuses --no-drain, naming why there is nothing to drain', async () => {
    const refused = await drive(['update', '--target', 'cloudflare', '--account-id', ACCOUNT, '--no-drain']);
    expect({ exited: refused.exited, names: /--no-drain is not a flag for this target/.test(refused.said) }).toEqual({ exited: true, names: true });
    expect(refused.said).toContain('waits for nothing');
  });

  it('GATE: a flag this target refuses by name is answered before a flag that is merely absent', async () => {
    // An operator who passed a flag that does not apply here is told THAT,
    // rather than being sent to supply the account id a refused command would
    // never have used.
    const held = process.env.MYCO_HOME;
    process.env.MYCO_HOME = freshHome();
    try {
      const refused = await drive(['update', '--target', 'cloudflare', '--no-drain']);
      expect({ exited: refused.exited, names: /--no-drain is not a flag for this target/.test(refused.said) }).toEqual({ exited: true, names: true });
      expect(refused.said).not.toContain('--account-id');
    } finally {
      if (held === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = held;
    }
  });
});

/**
 * The refusals as an operator meets them: one line on stderr and exit 1, from
 * the binary, with a `npx` on the PATH that answers the way a machine without
 * wrangler and a machine without a login answer.
 */
describe('what the CLI prints when this machine is not ready', () => {
  /** A directory holding an `npx` that answers as the script says. */
  const npxAnswering = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-cf-npx-'));
    writeFileSync(join(dir, 'npx'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return dir;
  };

  const withEnvironment = async (npxDir: string, argv: string[], home = freshHome()): Promise<{ exited: boolean; said: string; printed: string }> => {
    const held = { path: process.env.PATH, home: process.env.MYCO_HOME, token: process.env.CLOUDFLARE_API_TOKEN };
    process.env.PATH = `${npxDir}:${held.path ?? ''}`;
    process.env.MYCO_HOME = home;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      return await drive(argv);
    } finally {
      if (held.path === undefined) delete process.env.PATH; else process.env.PATH = held.path;
      if (held.home === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = held.home;
      if (held.token !== undefined) process.env.CLOUDFLARE_API_TOKEN = held.token;
    }
  };

  it.skipIf(process.platform === 'win32')('GATE: with no wrangler, `server create --target cloudflare` prints the install refusal and exits 1', async () => {
    const refused = await withEnvironment(npxAnswering('exit 1'), ['create', '--target', 'cloudflare', '--account-id', ACCOUNT]);
    expect({ exited: refused.exited, lines: refused.said.split('\n').length }).toEqual({ exited: true, lines: 1 });
    expect(refused.said).toContain('wrangler is not installed');
    expect(refused.said).not.toContain('posix_spawn');
  });

  /**
   * A wrangler that answers every command a create runs, so the verb completes
   * without reaching Cloudflare. The metadata answer is rendered from the
   * constants the code reads, so a new filter does not leave this hanging on
   * the index it waits for.
   */
  const wranglerAnswers = (version: string): string => [
    'case "$*" in',
    `  *"vectorize list-metadata-index"*) echo '${JSON.stringify(VECTOR_METADATA_FIELDS.map((field) => ({ propertyName: field, indexType: field === 'created_at' ? 'Number' : 'String' })))}';;`,
    `  *"vectorize list --json"*) echo '[{"name":"${VECTOR_INDEX_NAME}"}]';;`,
    `  *"vectorize get"*) echo '{"config":{"dimensions":${VECTOR_INDEX_DIMENSIONS},"metric":"cosine"}}';;`,
    '  *"d1 list --json"*) echo "[]";;',
    `  *"d1 create"*) echo 'database_id = "${DB_ID}"';;`,
    `  *"secrets-store store list"*) echo '${STORE}';;`,
    '  *" deploy "*) echo "Current Version ID: 16a2423e-af96-4310-b61b-4e2b5fd1310b";;',
    '  *whoami*) echo "account";;',
    `  *--version*) echo " wrangler ${version}";;`,
    'esac',
  ].join('\n');

  it.skipIf(process.platform === 'win32')('GATE: a finished create names the record at the path THIS home holds it, not a literal home', async () => {
    const home = freshHome();
    const done = await withEnvironment(npxAnswering(wranglerAnswers(BUNDLED_WORKER_WRANGLER)), ['create', '--target', 'cloudflare', '--account-id', ACCOUNT], home);

    expect({ exited: done.exited, said: done.said }).toEqual({ exited: false, said: '' });
    // An operator with MYCO_HOME elsewhere is sent to the file that exists.
    expect(done.printed).toContain(join(home, 'server', 'cloudflare', 'record.json'));
    expect(done.printed).not.toContain('~/.myco');
    expect(existsSync(join(home, 'server', 'cloudflare', 'record.json'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('GATE: a wrangler a major version from the bundled one says so to the operator, and the verb still finishes', async () => {
    // The note is reported through the lifecycle's `report`, and the CLI is the
    // only thing that wires one: unwired, the comparison talks to nobody.
    const done = await withEnvironment(npxAnswering(wranglerAnswers('3.0.0')), ['create', '--target', 'cloudflare', '--account-id', ACCOUNT]);

    expect({ exited: done.exited, said: done.said }).toEqual({ exited: false, said: '' });
    expect(done.printed).toContain('wrangler 3.0.0');
    expect(done.printed).toContain(BUNDLED_WORKER_WRANGLER);
  });

  it('GATE: `server config` without a record names the file this home would hold it in', async () => {
    const held = process.env.MYCO_HOME;
    const home = freshHome();
    process.env.MYCO_HOME = home;
    try {
      const refused = await drive(['config']);
      expect(refused.exited).toBe(true);
      expect(refused.said).toContain(join(home, 'server', 'cloudflare', 'record.json'));
      expect(refused.said).not.toContain('~/.myco');
    } finally {
      if (held === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = held;
    }
  });

  it.skipIf(process.platform === 'win32')('GATE: with no Cloudflare login, it names `wrangler login` and CLOUDFLARE_API_TOKEN, and exits 1', async () => {
    const npxDir = npxAnswering(`case "$*" in *whoami*) exit 1;; esac\necho " wrangler ${BUNDLED_WORKER_WRANGLER}"`);
    const refused = await withEnvironment(npxDir, ['create', '--target', 'cloudflare', '--account-id', ACCOUNT]);
    expect({ exited: refused.exited, lines: refused.said.split('\n').length }).toEqual({ exited: true, lines: 1 });
    expect(refused.said).toContain('wrangler login');
    expect(refused.said).toContain('CLOUDFLARE_API_TOKEN');
  });
});
