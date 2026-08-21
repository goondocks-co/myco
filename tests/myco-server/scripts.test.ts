import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { MEMBER_TOKEN_PATTERN, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';

const WORKER = fileURLToPath(new URL('../../packages/myco-server/worker/', import.meta.url));
const MIGRATIONS = join(WORKER, 'migrations');

function run(script: string, args: string[]) {
  const proc = Bun.spawnSync(['bun', `scripts/${script}`, ...args], { cwd: WORKER });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe('operator scripts', () => {
  it('mint prints a projects row and the token insert, applicable to a fresh database, without the raw token', () => {
    const { code, out, err } = run('mint-local.ts', ['proj_s', 'machine_s']);
    expect(code).toBe(0);
    const statements = out.split('\n').filter((l) => l && !l.startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements[0]).toMatch(/^INSERT OR IGNORE INTO projects \(project_id, name, created_at\) VALUES \('proj_s', 'proj_s', \d+\)$/);
    expect(statements[1]).toMatch(/^INSERT INTO member_tokens/);
    expect(out).not.toMatch(/\?/);
    expect(err).not.toMatch(/MYCO_MEMBER_TOKEN=/);
    const sqlite = new Database(':memory:');
    for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
    for (const s of statements) sqlite.exec(s);
    expect((sqlite.query(`SELECT project_id, machine_id, bytes_written FROM member_tokens`).get() as any)).toEqual({ project_id: 'proj_s', machine_id: 'machine_s', bytes_written: 0 });
    const row = sqlite.query(`SELECT id, predecessor_id, lineage_root, lineage_started_at, first_used_at, expires_at FROM member_tokens`).get() as any;
    expect(row).toEqual({ id: row.id, predecessor_id: null, lineage_root: row.id, lineage_started_at: row.expires_at - MEMBER_TOKEN_TTL_MS, first_used_at: null, expires_at: row.expires_at });
  });

  it('mint prints the raw token to stderr only when asked, and it matches the admission shape', () => {
    const { err } = run('mint-local.ts', ['proj_s', 'machine_s', '--print-token']);
    const token = /MYCO_MEMBER_TOKEN=(\S+)/.exec(err)?.[1];
    expect(token).toBeDefined();
    expect(token).toMatch(MEMBER_TOKEN_PATTERN);
  });

  it('mint refuses to run without a machine id', () => {
    const { code, err } = run('mint-local.ts', ['proj_s']);
    expect(code).toBe(2);
    expect(err).toContain('<machine_id>');
  });

  it('revoke prints the revocation update for the given id', () => {
    const { code, out } = run('revoke-local.ts', ['mt_x']);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^UPDATE member_tokens SET revoked_at = \d+ WHERE id = 'mt_x' AND revoked_at IS NULL;$/);
  });

  it('revoke --lineage prints the one update that revokes every live token of the lineage the id belongs to, applicable as printed', () => {
    const { code, out, err } = run('revoke-local.ts', ['mt_mid', '--lineage']);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^UPDATE member_tokens SET revoked_at = \d+ WHERE lineage_root = \(SELECT lineage_root FROM member_tokens WHERE id = 'mt_mid'\) AND revoked_at IS NULL;$/);
    expect(err).toContain('lineage');
    const sqlite = new Database(':memory:');
    for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
    sqlite.exec(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_s', 'proj_s', 0)`);
    sqlite.exec(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at)
                 VALUES ('mt_root', 'proj_s', 'm', 'h1', 9, 1, 0, NULL, 'mt_root', 0), ('mt_mid', 'proj_s', 'm', 'h2', 9, NULL, 0, 'mt_root', 'mt_root', 0), ('mt_tip', 'proj_s', 'm', 'h3', 9, NULL, 0, 'mt_mid', 'mt_root', 0), ('mt_other', 'proj_s', 'm', 'h4', 9, NULL, 0, NULL, 'mt_other', 0)`);
    sqlite.exec(out.trim());
    expect(sqlite.query(`SELECT id FROM member_tokens WHERE revoked_at IS NULL`).all()).toEqual([{ id: 'mt_other' }]);
    expect(run('revoke-local.ts', ['--lineage']).code).toBe(2);
  });

  it('emit-migrations writes one numbered file per schema step, matching the render, into the directory it is given and never into the committed migrations/ during a test', () => {
    const before = readdirSync(MIGRATIONS).map((name) => [name, readFileSync(join(MIGRATIONS, name), 'utf8')]);
    const out = mkdtempSync(join(tmpdir(), 'myco-migrations-'));
    const result = run('emit-migrations.ts', ['--out', out]);
    expect(result.code).toBe(0);
    expect(result.out.trim().split('\n')).toEqual(renderMigrationFiles().map((f) => f.name));
    for (const f of renderMigrationFiles()) expect(readFileSync(join(out, f.name), 'utf8')).toBe(f.sql);
    expect(readdirSync(MIGRATIONS).map((name) => [name, readFileSync(join(MIGRATIONS, name), 'utf8')])).toEqual(before);
  });
});
