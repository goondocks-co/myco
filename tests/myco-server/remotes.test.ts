import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { MAX_REMOTE_CHARS, normalizeRemote, projectForRemote, recordProjectRemote } from '@myco-server-worker/core/remotes.js';

describe('normalizeRemote', () => {
  it('maps every written form of one repository to one name', () => {
    const forms = [
      'git@github.com:goondocks/myco.git',
      'git@github.com:goondocks/myco',
      'ssh://git@github.com/goondocks/myco.git',
      'https://github.com/goondocks/myco.git',
      'https://github.com/goondocks/myco',
      'https://github.com/goondocks/myco/',
      'http://github.com/goondocks/myco.git',
      'git://github.com/goondocks/myco.git',
      'https://user:token@github.com/goondocks/myco.git',
      'ssh://git@github.com:22/goondocks/myco.git',
      'HTTPS://GitHub.com/goondocks/myco.git',
    ];
    expect(forms.map(normalizeRemote)).toEqual(forms.map(() => 'github.com/goondocks/myco'));
  });

  it('keeps path case, so two repositories differing only in case stay two', () => {
    expect(normalizeRemote('git@github.com:goondocks/Myco.git')).toBe('github.com/goondocks/Myco');
    expect(normalizeRemote('git@github.com:goondocks/myco.git')).toBe('github.com/goondocks/myco');
  });

  it('keeps two hosts apart, so different remotes never merge', () => {
    expect(normalizeRemote('git@gitlab.com:goondocks/myco.git')).toBe('gitlab.com/goondocks/myco');
    expect(normalizeRemote('git@github.com:goondocks/myco.git')).toBe('github.com/goondocks/myco');
  });

  it('answers null for anything that is not a remote', () => {
    const notRemotes = [
      '',
      '   ',
      'proj_0123456789abcdef0123456789abcdef',
      'myco',
      '/Users/chris/Repos/myco',
      'https://github.com',
      'https://github.com/',
      'ftp://github.com/goondocks/myco.git',
      'not a remote at all',
      `https://github.com/${'a'.repeat(MAX_REMOTE_CHARS)}`,
    ];
    expect(notRemotes.map(normalizeRemote)).toEqual(notRemotes.map(() => null));
  });
});

/**
 * The binding itself, executed.
 *
 * `remote` is the primary key, so one remote naming at most one Project is a
 * property of the table rather than a rule a writer keeps. These read the rows
 * back rather than asserting the call's answer: `recordProjectRemote` answers
 * false both for a collision and for a repeat, and only the stored row says
 * which Project the name still points at.
 */
describe('binding a remote to a Project', () => {
  const NOW = 1_700_000_000_000;
  const A = 'proj_one';
  const B = 'proj_two';

  function store(): { db: RelationalStore; sqlite: Database } {
    const sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
    for (const p of [A, B]) sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
    return { db: sqliteRelationalStore(sqlite), sqlite };
  }

  it('binds on first sight and answers the Project the remote names', async () => {
    const { db } = store();
    const remote = normalizeRemote('git@github.com:goondocks/myco.git')!;
    expect(await projectForRemote(db, remote)).toBeNull();
    expect(await recordProjectRemote(db, A, remote, NOW)).toBe(true);
    expect(await projectForRemote(db, remote)).toBe(A);
  });

  it('answers false for the same Project sending the same remote again, and rebinds nothing', async () => {
    const { db, sqlite } = store();
    const remote = normalizeRemote('https://github.com/goondocks/myco')!;
    expect(await recordProjectRemote(db, A, remote, NOW)).toBe(true);
    expect(await recordProjectRemote(db, A, remote, NOW + 1000)).toBe(false);
    expect(sqlite.query(`SELECT project_id AS p, first_seen_at AS t FROM project_remotes`).all())
      .toEqual([{ p: A, t: NOW }]);
  });

  /**
   * The collision is the one-remote-one-Project rule doing its job. The second
   * Project is not told, and the ignored write is emitted so an owner can see a
   * repository resolving to someone else's Project rather than wonder why.
   */
  it('leaves a bound remote with the Project that claimed it, and emits the ignored write', async () => {
    const { db, sqlite } = store();
    const remote = normalizeRemote('git@github.com:goondocks/myco.git')!;
    await recordProjectRemote(db, A, remote, NOW);

    const emitted: string[] = [];
    const log = console.log;
    console.log = (line: string) => { emitted.push(line); };
    try {
      expect(await recordProjectRemote(db, B, remote, NOW + 1)).toBe(false);
    } finally {
      console.log = log;
    }
    expect(await projectForRemote(db, remote)).toBe(A);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM project_remotes`).get()).toEqual({ n: 1 });
    expect(emitted.map((l) => JSON.parse(l) as Record<string, unknown>))
      .toEqual([{ kind: 'remote_bound', remote, projectId: B, status: 'held' }]);
  });

  it('keeps two spellings of one repository on one row, and two repositories apart', async () => {
    const { db, sqlite } = store();
    for (const written of ['git@github.com:goondocks/myco.git', 'https://github.com/goondocks/myco']) {
      await recordProjectRemote(db, A, normalizeRemote(written)!, NOW);
    }
    await recordProjectRemote(db, B, normalizeRemote('git@gitlab.com:goondocks/myco.git')!, NOW);
    expect(sqlite.query(`SELECT remote, project_id AS p FROM project_remotes ORDER BY remote`).all())
      .toEqual([{ remote: 'github.com/goondocks/myco', p: A }, { remote: 'gitlab.com/goondocks/myco', p: B }]);
  });
});
