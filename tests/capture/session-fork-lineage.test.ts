import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { TranscriptMiner } from '@myco/capture/transcript-miner.js';
import { getSession, updateSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

/**
 * Claude Code reissues a live session's id on a fork: it copies the whole
 * transcript under the new id and rewrites camelCase `sessionId` on every
 * line, leaving the predecessor id only in snake_case `session_id` on the
 * records written before the switch. Without a lineage stitch the fork
 * lands as an unrelated top-level session and the original freezes.
 *
 * Fixtures mirror the shape observed in a real 2.1.226 diagnostic bundle.
 */

const FORK_FIXTURE = path.join(import.meta.dir, '../fixtures/claude-session-fork.jsonl');
const CHAIN_FIXTURE = path.join(import.meta.dir, '../fixtures/claude-session-fork-chain.jsonl');
const FORK_OF_COMPACTED_FIXTURE = path.join(import.meta.dir, '../fixtures/claude-fork-of-compacted.jsonl');

describe('session-fork lineage stitch (miner)', () => {
  let tmpDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-lineage-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Stage a fixture as `<sessionId>.jsonl`, seed the row, and mine it. */
  function mine(fixture: string, sessionId: string, agent = 'claude-code'): void {
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.copyFileSync(fixture, transcriptPath);
    seedSession({ id: sessionId, agent });
    new TranscriptMiner().reconcileBatchKinds(sessionId, { agent, transcriptPath });
  }

  it('links a forked session to the id it was forked from', () => {
    mine(FORK_FIXTURE, 'fork-child-id');
    const row = getSession('fork-child-id', ALL_PROJECTS_SCOPE)!;
    expect(row.parent_session_id).toBe('fork-parent-id');
    expect(row.parent_session_reason).toBe('fork');
  });

  it('names the IMMEDIATE predecessor across a chain of forks, not the oldest ancestor', () => {
    // A → B → C. The transcript carries A on its earliest records and B on
    // the ones written after the first fork; taking the first divergent id
    // would wrongly report the grandparent.
    mine(CHAIN_FIXTURE, 'chain-child-id');
    const row = getSession('chain-child-id', ALL_PROJECTS_SCOPE)!;
    expect(row.parent_session_id).toBe('chain-parent-id');
    expect(row.parent_session_reason).toBe('fork');
  });

  it('reads the predecessor from a non-user record when that is the last one before the switch', () => {
    // The chain fixture's final pre-switch record is an `assistant` entry.
    // A user-only scan would miss it and fall back to the grandparent.
    mine(CHAIN_FIXTURE, 'chain-child-id');
    expect(getSession('chain-child-id', ALL_PROJECTS_SCOPE)!.parent_session_id).toBe('chain-parent-id');
  });

  it('links a fork of an ALREADY-COMPACTED session to the fork point, not the pre-compact ancestor', () => {
    // A --compact--> B --fork--> C. The fork copies B's transcript verbatim,
    // so A's compact-summary record rides along inside C's file. Selecting
    // the parent by marker rather than by position would return A here and
    // leave B looking orphaned and frozen — the exact symptom this feature
    // exists to fix. Real shape: ~/.claude/projects/…/15883b4b-….jsonl
    // carries its predecessor on lines 8-754 with the summary at line 8.
    mine(FORK_OF_COMPACTED_FIXTURE, 'forked-child-id');
    const row = getSession('forked-child-id', ALL_PROJECTS_SCOPE)!;
    expect(row.parent_session_id).toBe('new-session-id');
    expect(row.parent_session_id).not.toBe('old-session-id');
  });

  it('does not re-file the parent turns as the child session\'s own prompts', () => {
    // The fork copies the parent's conversation forward verbatim. Those turns
    // are already captured under the parent, so mining them here would show
    // the same prompt on both halves of the lineage-linked pair.
    mine(FORK_FIXTURE, 'fork-child-id');
    const prompts = listBatchesBySession('fork-child-id', { scope: ALL_PROJECTS_SCOPE })
      .map((b) => b.user_prompt);
    expect(prompts).toContain('good to continue');
    expect(prompts).not.toContain('start the foundation work');
    // The live smoke found this gap: a forked transcript's head records
    // carry no `session_id` at all, so a per-record filter let the
    // parent's own turn through. The boundary has to be positional.
    expect(prompts).not.toContain('pre-fork turn with no session_id stamp');
  });

  it('never stitches for an agent that declares no sessionContinuation', () => {
    // Same fixture bytes mined as codex: a foreign transcript carrying
    // Claude-shaped fields must not write lineage.
    mine(FORK_FIXTURE, 'fork-child-id', 'codex');
    expect(getSession('fork-child-id', ALL_PROJECTS_SCOPE)!.parent_session_id).toBeNull();
  });

  it('never overwrites lineage that is already recorded', () => {
    const transcriptPath = path.join(tmpDir, 'fork-child-id.jsonl');
    fs.copyFileSync(FORK_FIXTURE, transcriptPath);
    seedSession({ id: 'fork-child-id', agent: 'claude-code' });
    updateSession(
      'fork-child-id',
      { parent_session_id: 'someone-else', parent_session_reason: 'resume' },
      ALL_PROJECTS_SCOPE,
    );
    new TranscriptMiner().reconcileBatchKinds('fork-child-id', {
      agent: 'claude-code',
      transcriptPath,
    });
    const row = getSession('fork-child-id', ALL_PROJECTS_SCOPE)!;
    expect(row.parent_session_id).toBe('someone-else');
    expect(row.parent_session_reason).toBe('resume');
  });

  it('is idempotent across re-mines', () => {
    const transcriptPath = path.join(tmpDir, 'fork-child-id.jsonl');
    fs.copyFileSync(FORK_FIXTURE, transcriptPath);
    seedSession({ id: 'fork-child-id', agent: 'claude-code' });
    const miner = new TranscriptMiner();
    miner.reconcileBatchKinds('fork-child-id', { agent: 'claude-code', transcriptPath });
    fs.appendFileSync(transcriptPath, '\n');
    miner.reconcileBatchKinds('fork-child-id', { agent: 'claude-code', transcriptPath });
    const row = getSession('fork-child-id', ALL_PROJECTS_SCOPE)!;
    expect(row.parent_session_id).toBe('fork-parent-id');
    expect(row.parent_session_reason).toBe('fork');
  });

  it('leaves a session whose records all carry its own id unlinked', () => {
    // Guards the divergence discriminator: a transcript that never switched
    // ids must not acquire a self-referential or spurious parent.
    const transcriptPath = path.join(tmpDir, 'chain-child-id.jsonl');
    const selfOnly = fs.readFileSync(CHAIN_FIXTURE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.session_id === undefined || r.session_id === 'chain-child-id');
    fs.writeFileSync(transcriptPath, selfOnly.map((r) => JSON.stringify(r)).join('\n') + '\n');
    seedSession({ id: 'chain-child-id', agent: 'claude-code' });
    new TranscriptMiner().reconcileBatchKinds('chain-child-id', {
      agent: 'claude-code',
      transcriptPath,
    });
    expect(getSession('chain-child-id', ALL_PROJECTS_SCOPE)!.parent_session_id).toBeNull();
  });
});
