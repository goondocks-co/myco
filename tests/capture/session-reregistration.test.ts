import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, withDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { getSession, upsertSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

/**
 * Re-registration semantics: every agent re-fires session registration
 * mid-session (Claude Code on compact/resume, Codex desktop periodically,
 * Pi after pre-compact), and each re-register funnels through
 * `upsertSession`. The conflict clause must therefore be additive —
 * enriching the row, never erasing what an earlier, richer registration
 * already recorded.
 */
describe('upsertSession re-registration semantics', () => {
  let root: string;
  let db: Database;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reregister-'));
    db = openDatabase(path.join(root, 'myco.db'));
    createSchema(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const withDb = <T>(fn: () => T): T => withDatabase(db, fn);

  it('keeps the earliest started_at when a re-register arrives later', () => {
    withDb(() => {
      upsertSession({ id: 's1', agent: 'pi', started_at: 1000, created_at: 1000, machine_id: 'm' });
      upsertSession({ id: 's1', agent: 'pi', started_at: 5000, created_at: 5000, machine_id: 'm' });
      expect(getSession('s1', ALL_PROJECTS_SCOPE)!.started_at).toBe(1000);
    });
  });

  it('keeps the earliest started_at when a buffer replay arrives with an EARLIER time', () => {
    withDb(() => {
      upsertSession({ id: 's1b', agent: 'claude-code', started_at: 5000, created_at: 5000, machine_id: 'm' });
      upsertSession({ id: 's1b', agent: 'claude-code', started_at: 1000, created_at: 1000, machine_id: 'm' });
      expect(getSession('s1b', ALL_PROJECTS_SCOPE)!.started_at).toBe(1000);
    });
  });

  it('does not null branch/project_root/user/lineage/content_hash on sparse re-register', () => {
    withDb(() => {
      upsertSession({
        id: 's2',
        agent: 'codex',
        started_at: 1,
        created_at: 1,
        machine_id: 'm',
        branch: 'main',
        project_root: '/r',
        user: 'chris',
        parent_session_id: 'p1',
        parent_session_reason: 'compact continuation',
        content_hash: 'h1',
      });
      // The defensive/re-register path passes only the minimal fields.
      upsertSession({ id: 's2', agent: 'codex', started_at: 2, created_at: 2, machine_id: 'm' });
      const row = getSession('s2', ALL_PROJECTS_SCOPE)!;
      expect([
        row.branch,
        row.project_root,
        row.user,
        row.parent_session_id,
        row.parent_session_reason,
        row.content_hash,
      ]).toEqual(['main', '/r', 'chris', 'p1', 'compact continuation', 'h1']);
    });
  });

  it('lets an explicit re-register value still win over the stored one', () => {
    withDb(() => {
      upsertSession({
        id: 's3',
        agent: 'claude-code',
        started_at: 1,
        created_at: 1,
        machine_id: 'm',
        branch: 'main',
        parent_session_id: 'p1',
        parent_session_reason: 'compact continuation',
      });
      upsertSession({
        id: 's3',
        agent: 'claude-code',
        started_at: 2,
        created_at: 2,
        machine_id: 'm',
        branch: 'feature/x',
        parent_session_id: 'p2',
        parent_session_reason: 'resume',
      });
      const row = getSession('s3', ALL_PROJECTS_SCOPE)!;
      expect(row.branch).toBe('feature/x');
      expect(row.parent_session_id).toBe('p2');
      expect(row.parent_session_reason).toBe('resume');
    });
  });

  it('documents the accepted staleness: a reloaded session keeps its old content_hash until the next close recomputes it', () => {
    withDb(() => {
      upsertSession({ id: 's4', agent: 'claude-code', started_at: 1, created_at: 1, machine_id: 'm', content_hash: 'stale' });
      upsertSession({ id: 's4', agent: 'claude-code', started_at: 2, created_at: 2, machine_id: 'm' });
      expect(getSession('s4', ALL_PROJECTS_SCOPE)!.content_hash).toBe('stale');
    });
  });
});
