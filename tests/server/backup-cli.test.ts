import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { resolveLocalPaths, writeLocalRecord } from '@myco/server/local.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { renderMigrationFile } from '@myco-server-worker/db/migrate.js';
import { createRecoveryBundle } from '@myco/server/recovery-bundle.js';

/**
 * Everything the source volume holds except its recovery-hold ledger, which a backup writes to by design: it holds
 * every object its snapshot names until the artifact completes.
 */
const sourceBesideItsHolds = (databasePath: string) => {
  const sqlite = new Database(databasePath, { readonly: true });
  try {
    const tables = (sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'recovery_holds' ORDER BY name").all() as Array<{ name: string }>);
    return tables.map(({ name }) => [name, sqlite.query(`SELECT * FROM "${name}"`).all()] as const);
  } finally { sqlite.close(); }
};
const holdRows = (databasePath: string) => {
  const sqlite = new Database(databasePath, { readonly: true });
  try { return sqlite.query('SELECT holder, release_reason, released_by FROM recovery_holds').all(); } finally { sqlite.close(); }
};

async function invokeServer(root: string, args: string[]) {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const child = Bun.spawn([process.execPath, '--no-env-file', '--tsconfig-override', path.join(repo, 'tsconfig.json'), '-e',
    `import {run} from ${JSON.stringify(path.join(repo, 'packages/myco/src/cli/server.ts'))}; await run(${JSON.stringify(args)});`], {
    cwd: root, env: { ...process.env, MYCO_HOME: path.join(root, 'home'), MYCO_TRAMPOLINED: '1', PATH: root },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => { child.kill(); }, 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, text: stdout + stderr };
  } finally { clearTimeout(timeout); child.kill(); }
}

it('routes backup and restore flags to the selected retained target without invoking Compose', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-backup-cli-'));
  const paths = resolveLocalPaths(path.join(root, 'home'));
  const fixture = sqliteEnv();
  writeLocalRecord({ port: 8787, sourceFrom: 'socket' }, paths);
  fixture.sqlite.query('VACUUM INTO ?').run(paths.databasePath);
  const original = sourceBesideItsHolds(paths.databasePath);
  const invoke = (args: string[]) => invokeServer(root, args);
  try {
    const destination = path.join(root, 'backup');
    const local = await invoke(['backup', '--target', 'local', '--to', destination]);
    expect(local.code).toBe(0);
    expect(local.text).toContain('Verified data artifact');
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'recovery.json'), 'utf8')).status).toBe('complete');
    const cloud = await invoke(['backup', '--target', 'cloudflare', '--account-id', 'fixture-account', '--to', path.join(root, 'cloud')]);
    expect(cloud.code).toBe(1);
    expect(cloud.text).toContain('No Cloudflare Deployment record');
    const restore = await invoke(['restore', '--target', 'local', '--from', destination, '--yes']);
    expect(restore.code).toBe(1);
    expect(restore.text).toContain('native recovery needs --secrets-from');
    const unacknowledged = await invoke(['restore', '--target', 'local', '--from', destination, '--secrets-from', paths.secretsFile, '--yes']);
    expect(unacknowledged.code).toBe(1);
    expect(unacknowledged.text).toContain('--source-retired');
    const existing = await invoke(['restore', '--target', 'local', '--from', destination, '--secrets-from', paths.secretsFile, '--source-retired', '--yes']);
    expect(existing.code).toBe(1);
    expect(existing.text).toContain('fresh local Deployment directory');
    const bare = await invoke(['backup', '--target', 'local', '--to']);
    expect(bare.code).toBe(1);
    expect(bare.text).toContain('backup needs --to <dir>');
    expect(fs.existsSync(path.join(root, 'true'))).toBe(false);
    expect(sourceBesideItsHolds(paths.databasePath)).toEqual(original);
    // The one thing a backup writes to its source: the hold it took, released once its artifact completed.
    expect(holdRows(paths.databasePath)).toEqual([{ holder: 'operator', release_reason: 'complete', released_by: 'operator' }]);
  } finally { fixture.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('the restore command reports retired backup data in the same plain words as the dashboard', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-backup-cli-'));
  const source = new Database(path.join(root, 'source.sqlite'));
  try {
    for (const step of SCHEMA_STEPS.filter(({ version }) => version <= 85)) source.exec(renderMigrationFile(step));
    source.exec(`INSERT INTO projects(project_id,name,created_at) VALUES('proj_copy','Copy',1);
      INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent_copy','Agent','built-in',1,1);
      INSERT INTO skill_candidates(project_id,id,agent_id,topic,rationale,created_at,updated_at)
        VALUES('proj_copy','candidate','agent_copy','topic','reason',1,1);
      INSERT INTO digest_extracts(project_id,id,agent_id,tier,content,generated_at)
        VALUES('proj_copy','digest','agent_copy',1,'digest',1);
      INSERT INTO cortex_instructions(project_id,id,agent_id,content,input_hash,generated_at)
        VALUES('proj_copy','instructions','agent_copy','old instructions','hash',1);`);
    const destination = path.join(root, 'backup');
    await createRecoveryBundle(destination, {
      source: { target: 'local', locator: 'copy-fixture' },
      snapshot: async (file) => {
        source.query('VACUUM INTO ?').run(file);
        return { configuration: { port: 8787 }, credentialsRequired: ['SECRET_WRAP_KEY'] };
      },
      blob: async () => { throw new Error('copy fixture holds no blobs'); },
    });
    const secrets = path.join(root, 'recovery.env');
    fs.writeFileSync(secrets, 'SECRET_WRAP_KEY=' + Buffer.alloc(32, 7).toString('base64') + '\n', { mode: 0o600 });
    const result = await invokeServer(root, ['restore', '--target', 'local', '--from', destination,
      '--secrets-from', secrets, '--source-retired', '--new-signin', '--yes']);
    expect(result.code).toBe(0);
    const notice = "This backup includes older data this version no longer keeps (generated skills, digests, old instructions). It won't be restored.";
    expect(result.text).toContain(notice);
    expect(result.text.split(notice)).toHaveLength(2);
    expect(result.text).not.toContain('schema step');
    expect(result.text).not.toContain('#');
    const restored = new Database(resolveLocalPaths(path.join(root, 'home')).databasePath, { readonly: true });
    try {
      expect(restored.query("SELECT name FROM sqlite_master WHERE name IN ('skill_candidates','digest_extracts','cortex_instructions')").all()).toEqual([]);
      expect(restored.query("SELECT name FROM projects WHERE project_id='proj_copy'").get()).toEqual({ name: 'Copy' });
    } finally { restored.close(); }
  } finally { source.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
