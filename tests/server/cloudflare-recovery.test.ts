import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { seededSqlite } from '../myco-server/helpers/d1.js';
import { createRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { restoreCloudflareDeployment } from '@myco/server/cloudflare-recovery.js';
import { readDeploymentRecord } from '@myco/server/cloudflare.js';
import { VECTOR_INDEX_DIMENSIONS, VECTOR_METADATA_FIELDS } from '@myco/server/vector-config.js';
import type { CommandRunner } from '@myco/server/runner.js';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hosted-recovery-'));
  const source = path.join(root, 'artifact');
  const mycoHome = path.join(root, 'home');
  const secretsFile = path.join(root, 'independent.env');
  const data = seededSqlite();
  data.exec("INSERT INTO schema_meta(key,value) VALUES('fixture_note','keep this finding')");
  await createRecoveryBundle(source, {
    source: { target: 'cloudflare', locator: 'original' },
    snapshot: async (file) => { data.query('VACUUM INTO ?').run(file); return { configuration: { fleet: 2 }, credentialsRequired: [] }; },
    blob: async () => { throw new Error('unexpected blob'); },
  });
  data.close();
  fs.writeFileSync(secretsFile, `SECRET_WRAP_KEY=${Buffer.alloc(32, 7).toString('base64')}\nSESSION_SECRET=fixture-session\nGITHUB_CLIENT_ID=fixture-client\nGITHUB_CLIENT_SECRET=fixture-client-secret\n`, { mode: 0o600 });
  const destination = new Database(':memory:');
  let loseImport = true;
  let creates = 0;
  const deployments: string[] = [];
  const secretCommands: string[] = [];
  const runner: CommandRunner = { async run(_command, args, options) {
    const flat = args.slice(2).join(' ');
    const answer = (stdout = '', code = 0) => ({ code, stdout, stderr: '' });
    if (flat === '--version') return answer('4.126.0');
    if (flat === 'whoami') return answer('fixture');
    expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe('fixture-account');
    if (flat === 'd1 list --json' || flat === 'vectorize list --json') return answer('[]');
    if (flat.startsWith('d1 create')) { creates++; return answer('11111111-2222-4333-8444-555555555555'); }
    if (flat.startsWith('r2 bucket create') || flat.startsWith('vectorize create ')) { creates++; return answer(); }
    if (flat.startsWith('vectorize get ')) return answer(JSON.stringify({ config: { dimensions: VECTOR_INDEX_DIMENSIONS, metric: 'cosine' } }));
    if (flat.startsWith('vectorize list-metadata-index ')) return answer(JSON.stringify(VECTOR_METADATA_FIELDS.map(propertyName => ({ propertyName, indexType: propertyName === 'created_at' ? 'Number' : 'String' }))));
    if (flat.startsWith('secrets-store store list')) return answer('f'.repeat(32));
    if (flat.startsWith('secrets-store secret create') || flat.startsWith('secret ')) { secretCommands.push(flat); return answer(); }
    if (flat.startsWith('deployments list')) return answer('Worker not found [code: 10007]', 1);
    if (args.includes('--command')) return answer(JSON.stringify([{ success: true, results: destination.query(args[args.indexOf('--command') + 1]!).all() }]));
    if (args.includes('--file')) {
      const file = args[args.indexOf('--file') + 1]!;
      destination.transaction(() => destination.exec(fs.readFileSync(file, 'utf8')))();
      if (loseImport && file.endsWith('/snapshot.sql')) { loseImport = false; throw new Error('lost reply'); }
      return answer();
    }
    if (flat.startsWith('d1 migrations apply')) return answer();
    if (flat.startsWith('deploy ')) {
      expect(readDeploymentRecord(mycoHome)).toBeNull();
      const config = fs.readFileSync(path.join(options!.cwd!, args[args.indexOf('-c') + 1]!), 'utf8');
      deployments.push(config);
      expect(destination.query("SELECT value FROM schema_meta WHERE key='fixture_note'").get()).toEqual({ value: 'keep this finding' });
      return answer('Current Version ID: 11111111-2222-4333-8444-555555555555\nhttps://fixture.account.workers.dev');
    }
    throw new Error(`unexpected ${flat}`);
  } };
  return { source, secretsFile, mycoHome, destination, deployments, secretCommands, creates: () => creates,
    restore: (newSignIn = false) => restoreCloudflareDeployment({ source, secretsFile, mycoHome, accountId: 'fixture-account', runner, newSignIn }),
    cleanup: () => { destination.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

it('resumes data transfer on the same fresh resources and publishes only after bootstrap and credentials', async () => {
  const f = await fixture();
  try {
    const original = fs.readFileSync(path.join(f.source, 'myco.sqlite'));
    await expect(f.restore()).rejects.toThrow('Cloudflare recovery import did not finish');
    expect(readDeploymentRecord(f.mycoHome)).toBeNull();
    const result = await f.restore();
    expect(result.record.fleet).toBe(2);
    expect(result.record.workerName).toMatch(/^myco-recovery-/);
    expect(f.creates()).toBe(3);
    expect(f.deployments).toHaveLength(2);
    expect(f.deployments[0]).not.toContain('d1_databases');
    expect(f.deployments[0]).not.toContain('triggers');
    expect(f.deployments[1]).toContain('MYCO_ORIGIN = "https://fixture.account.workers.dev"');
    expect(readDeploymentRecord(f.mycoHome)).toEqual(result.record);
    expect(fs.readFileSync(path.join(f.source, 'myco.sqlite'))).toEqual(original);
    await expect(f.restore()).rejects.toThrow('fresh MYCO_HOME');
  } finally { f.cleanup(); }
});

it('keeps the explicit sign-in choice across retry and installs no recovered GitHub credentials in new-signin mode', async () => {
  const f = await fixture();
  try {
    await expect(f.restore(true)).rejects.toThrow('Cloudflare recovery import did not finish');
    await expect(f.restore(false)).rejects.toThrow('same sign-in choice');
    expect(readDeploymentRecord(f.mycoHome)).toBeNull();
    await f.restore(true);
    expect(f.secretCommands.some(command => command.startsWith('secret put SESSION_SECRET'))).toBe(true);
    expect(f.secretCommands.some(command => command.startsWith('secret bulk'))).toBe(false);
  } finally { f.cleanup(); }
});

it('refuses unconfirmed provisioning instead of creating another resource on retry', async () => {
  const f = await fixture();
  try {
    await expect(f.restore()).rejects.toThrow('did not finish');
    const file = path.join(f.mycoHome, 'server', 'cloudflare', 'recovery.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...journal, pending: `D1 ${journal.name}` }));
    await expect(f.restore()).rejects.toThrow('unconfirmed D1');
    expect(f.creates()).toBe(3);
    expect(readDeploymentRecord(f.mycoHome)).toBeNull();
  } finally { f.cleanup(); }
});
