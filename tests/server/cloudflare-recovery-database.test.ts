import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_STEPS } from '../../packages/myco-server/src/db/schema.js';
import { migrationFileName } from '../../packages/myco-server/src/db/migrate.js';
import { SERVER_SCHEMA_VERSION } from '../../packages/myco-server/src/constants.js';
import { restoreCloudflareDatabase } from '@myco/server/cloudflare-recovery-database.js';
import type { CommandRunner } from '@myco/server/runner.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hosted-import-'));
  const databasePath = path.join(root, 'source.sqlite');
  const source = new Database(databasePath);
  const destination = new Database(':memory:');
  for (const step of SCHEMA_STEPS.filter((step) => step.version < SERVER_SCHEMA_VERSION)) source.exec(step.statements.join(';\n'));
  source.exec("INSERT INTO schema_meta(key,value) VALUES('fixture_note','durable knowledge')");
  source.close();
  let loseImportReply = false;
  let mutations = 0;
  const runner: CommandRunner = { async run(_command, args, options) {
    expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe('fixture-account');
    if (args.includes('--command')) {
      const sql = args[args.indexOf('--command') + 1]!;
      return { code: 0, stdout: JSON.stringify([{ success: true, results: destination.query(sql).all() }]), stderr: '' };
    }
    mutations++;
    if (args.includes('--file')) {
      const sql = fs.readFileSync(args[args.indexOf('--file') + 1]!, 'utf8');
      destination.transaction(() => destination.exec(sql))();
      if (loseImportReply) { loseImportReply = false; throw new Error('private SQL from interrupted provider response'); }
    } else if (args.includes('migrations')) {
      for (const step of SCHEMA_STEPS) {
        const name = migrationFileName(step);
        if (destination.query('SELECT 1 FROM d1_migrations WHERE name=?').get(name) !== null) continue;
        destination.transaction(() => {
          destination.exec(step.statements.join(';\n'));
          destination.query('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
        })();
      }
    } else throw new Error(`unexpected command ${args.join(' ')}`);
    return { code: 0, stdout: '', stderr: '' };
  } };
  return {
    root, destination,
    options: { accountId: 'fixture-account', databaseName: 'fixture-only', configDir: root, databasePath, sourceFingerprint: 'a'.repeat(64), runner },
    interrupt: () => { loseImportReply = true; },
    mutations: () => mutations,
    cleanup: () => { destination.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

it('resumes a persisted import after a lost reply and migrates once while retaining source data', async () => {
  const f = fixture();
  try {
    const sourceBytes = fs.readFileSync(f.options.databasePath);
    f.interrupt();
    await expect(restoreCloudflareDatabase(f.options)).rejects.toThrow('Cloudflare recovery import did not finish');
    expect(fs.readdirSync(f.root)).toEqual(['source.sqlite']);
    expect(await restoreCloudflareDatabase(f.options)).toEqual({ schemaVersion: SERVER_SCHEMA_VERSION, imported: false });
    expect(f.destination.query("SELECT value FROM schema_meta WHERE key='fixture_note'").get()).toEqual({ value: 'durable knowledge' });
    expect(f.destination.query('SELECT count(*) AS count FROM d1_migrations').get()).toEqual({ count: SCHEMA_STEPS.length });
    expect(await restoreCloudflareDatabase(f.options)).toEqual({ schemaVersion: SERVER_SCHEMA_VERSION, imported: false });
    expect(f.destination.query('SELECT count(*) AS count FROM d1_migrations').get()).toEqual({ count: SCHEMA_STEPS.length });
    expect(fs.readFileSync(f.options.databasePath)).toEqual(sourceBytes);
  } finally { f.cleanup(); }
});

it('refuses an unrelated or incomplete destination before any mutation', async () => {
  const f = fixture();
  try {
    f.destination.exec('CREATE TABLE unrelated(id INTEGER)');
    await expect(restoreCloudflareDatabase(f.options)).rejects.toThrow('empty destination');
    f.destination.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO schema_meta VALUES('version','36')");
    await expect(restoreCloudflareDatabase(f.options)).rejects.toThrow('no matching completed recovery import');
    expect(f.mutations()).toBe(0);
  } finally { f.cleanup(); }
});
