/**
 * The input a `cortex-instructions` run is handed.
 *
 * Two properties carry the feature: the payload holds the 1.4 limits, and the
 * hash moves exactly when the material or the configuration behind it moves.
 * A hash that drifted on the clock would make the dedup a no-op and put a
 * frontier-model run on a daily schedule for nothing; a hash that stood still
 * over new material would freeze the artifact forever.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildDigestInput, CONTENT_PREVIEW_MAX_CHARS, DIGEST_EXCERPT_MAX_CHARS,
  DIGEST_FRESH_DIRECTION, DIGEST_FULL_READ_BODY_CHARS, DIGEST_MATERIAL_TIER, DIGEST_SESSION_PAGE_LIMIT, DIGEST_SPORE_PAGE_LIMIT,
  DIGEST_TIER_MIN_CONTEXT_TOKENS, MATERIAL_ROW_KEYS_ESTIMATE_CHARS, materialRowsForTier, preview,
  RECENT_PLAN_LIMIT, RECENT_SESSION_LIMIT, RECENT_WISDOM_SPORE_LIMIT, RUN_SESSION_LABEL_CHARS,
  RUN_SESSION_SUMMARY_CHARS, RUN_SESSION_TITLE_CHARS, SESSION_ROW_OVERHEAD_CHARS,
} from '@myco-server-worker/core/cortex-input.js';
import { SPORE_FULL_READ_BUDGET } from '@myco-server-worker/core/spores.js';
import { recallLeaves, type RecallLeaves } from '@myco-server-worker/core/recall.js';
import { SERVED_TOOLS, type ServedTool } from '@myco-server-worker/core/tool-catalogue.js';
import { TOOL_DEFINITIONS } from '@myco-server-worker/mcp/definitions.js';
import { NO_OP, TOOL_REGISTRY } from '@myco-server-worker/mcp/registry.js';
import { upsertDigest } from '@myco-server-worker/core/digests.js';
import { insertSpore } from '@myco-server-worker/core/spores.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteEnv } from './helpers/fixtures.js';

/** The ops the registry answers, across every tool: what the prompt may teach. */
const ANSWERED_OPS = Object.values(TOOL_REGISTRY)
  .flatMap((entry) => Object.entries(entry.ops).filter(([, value]) => 'handler' in value).map(([op]) => op))
  .filter((op) => op !== NO_OP);

/** Every tool the registry answers at least one op of. */
const answeredTools = (): ServedTool[] =>
  SERVED_TOOLS.filter((name) => Object.values(TOOL_REGISTRY[name].ops).some((entry) => 'handler' in entry));

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const LEAVES: RecallLeaves = recallLeaves({});
const CAPABILITIES = { cortex: true, canopy: false, skills: false, vault_evolution: false } as const;

function fixture() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
  let seq = 0;
  const session = (title: string, summary: string, at = NOW - 1000 * ++seq) => {
    const id = `sess_${seq}`;
    e.sqlite.run(
      `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at, title, summary)
       VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?, ?, ?)`,
      [id, at, at, at, at + 1, title, summary],
    );
    return id;
  };
  const spore = async (observationType: string, content: string) => {
    seq += 1;
    await insertSpore(e.db, SCOPE, {
      id: `sp_${seq}`, agentId: 'myco-agent', sessionId: null, promptId: null, observationType,
      content, context: null, filePath: null, tags: null, contentHash: null, properties: null, author: null, createdAt: NOW - seq,
    });
  };
  const plan = (title: string, content: string) => {
    seq += 1;
    e.sqlite.run(
      `INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, status, content, content_hash, created_at, updated_at, token_id, received_at)
       VALUES ('proj_1', ?, 'sess_x', ?, 'm1', ?, 'active', ?, ?, ?, ?, 'tok_1', ?)`,
      [`plan_${seq}`, `ev_plan_${seq}`, title, content, `h_${seq}`, NOW - seq, NOW - seq, NOW - seq],
    );
  };
  const leaf = (name: string, value: unknown) =>
    e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [name, JSON.stringify(value), NOW]);
  const build = (over: Partial<{ leaves: RecallLeaves; capabilities: typeof CAPABILITIES; now: number }> = {}) =>
    buildInstructionsInput(e.db, SCOPE, { leaves: LEAVES, capabilities: CAPABILITIES, now: NOW, ...over });
  const digest = (over: Partial<{ leaves: RecallLeaves; fresh: boolean; now: number }> = {}) =>
    buildDigestInput(e.db, SCOPE, { leaves: LEAVES, fresh: false, now: NOW, ...over });
  return { ...e, session, spore, plan, leaf, build, digest };
}

describe('the preview a payload carries', () => {
  it('keeps a short body whole and cuts a long one on a word boundary', () => {
    expect(preview('short body')).toBe('short body');
    const long = 'word '.repeat(200);
    const cut = preview(long)!;
    expect(cut.length).toBeLessThanOrEqual(CONTENT_PREVIEW_MAX_CHARS + 1);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.slice(0, -1).endsWith(' ')).toBe(false);
  });

  it('rewrites a retired tool name rather than teaching it onward', () => {
    expect(preview('call myco_remember to save that')).toBe('call [retired Myco tool] to save that');
  });

  it('answers nothing for an absent or empty body', () => {
    expect(preview(null)).toBeNull();
    expect(preview('')).toBeNull();
  });
});



describe('the input a digest run is handed', () => {
  /**
   * The hash covers the prompt itself, so an edit to any line the model reads
   * moves it with no second constant to remember to bump.
   */
  it('is the hash of the prompt itself, and stands still over the same material', async () => {
    const f = fixture();
    f.session('One', 'first');
    const built = await f.digest();
    expect(built.inputHash).toBe(await sha256Hex(built.instruction));
    expect((await f.digest({ now: NOW + 86_400_000 })).inputHash).toBe(built.inputHash);
  });

  it('names what each tier holds, and says so plainly when the project holds none', async () => {
    const f = fixture();
    expect((await f.digest()).instruction).toContain('No digest has been written yet');

    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: 'myco-agent', tier: 5000, content: 'a'.repeat(120), substrateHash: null, generatedAt: NOW - 10_000 });
    await upsertDigest(f.db, SCOPE, { id: 'd2', agentId: 'myco-agent', tier: 10000, content: 'b'.repeat(400), substrateHash: null, generatedAt: NOW - 20_000 });
    const built = await f.digest();
    expect(built.instruction).toContain('- Tier 5000: 120 characters, generated ');
    expect(built.instruction).toContain('- Tier 10000: 400 characters, generated ');
  });

  it('counts the active spores and the sessions that ended since the newest digest', async () => {
    const f = fixture();
    // The fixture starts each session a second before the last, so the first
    // written is the newer of the two; the digest is dated between them.
    f.session('Newer work', 'after the digest');
    f.session('Older work', 'before the digest');
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: 'myco-agent', tier: 5000, content: 'held', substrateHash: null, generatedAt: NOW - 1500 });
    await f.spore('decision', 'we chose the queue');
    await f.spore('gotcha', 'the drain rebuilds');

    const built = await f.digest();
    expect(built.counts).toEqual({ spores: 2, sessionsInWindow: 1, windowFull: false });
    expect(built.instruction).toContain('- Active spores: 2');
    expect(built.instruction).toContain('- Sessions that ended since the newest digest: 1');
  });

  it('states the per-tier material windows and the pages the routes hand the run', async () => {
    const f = fixture();
    const built = await f.digest();
    for (const [tier, tokens] of Object.entries(DIGEST_TIER_MIN_CONTEXT_TOKENS)) {
      expect(built.instruction).toContain(`- Tier ${tier}: ${tokens} estimated tokens of material.`);
    }
    expect(built.instruction).toContain(`at most ${DIGEST_SPORE_PAGE_LIMIT} previews`);
    expect(built.instruction).toContain(`at most ${DIGEST_SESSION_PAGE_LIMIT} sessions`);
    expect(built.instruction).toContain(`up to ${SPORE_FULL_READ_BUDGET} full reads`);
    // The full reads spend against the same window the page ceilings are cut from.
    expect(built.instruction).toContain(`bounded to ${DIGEST_FULL_READ_BODY_CHARS} characters`);
    expect(DIGEST_FULL_READ_BODY_CHARS * SPORE_FULL_READ_BUDGET).toBeLessThanOrEqual(DIGEST_TIER_MIN_CONTEXT_TOKENS[DIGEST_MATERIAL_TIER]! * 4);
    expect(materialRowsForTier(10000, 200, 80)).toBeGreaterThan(materialRowsForTier(1500, 200, 80));
    // Every part of a row but its keys is cut to a constant, so the page ceilings are derived rather than guessed.
    expect(DIGEST_SESSION_PAGE_LIMIT).toBe(materialRowsForTier(DIGEST_MATERIAL_TIER, RUN_SESSION_SUMMARY_CHARS, SESSION_ROW_OVERHEAD_CHARS));
    expect(SESSION_ROW_OVERHEAD_CHARS).toBe(RUN_SESSION_TITLE_CHARS + RUN_SESSION_LABEL_CHARS + MATERIAL_ROW_KEYS_ESTIMATE_CHARS);
  });

  it('tells the run to start over only when the owner asked for it, and hashes the material either way', async () => {
    const f = fixture();
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: 'myco-agent', tier: 5000, content: 'held', substrateHash: null, generatedAt: NOW - 40_000 });
    const carried = await f.digest();
    const scratch = await f.digest({ fresh: true });
    expect(carried.instruction).not.toContain(DIGEST_FRESH_DIRECTION);
    expect(scratch.instruction).toContain(DIGEST_FRESH_DIRECTION);
    expect(scratch.inputHash).toBe(carried.inputHash);
  });

  it('holds its hash still over the clock and moves it when the material moves', async () => {
    const f = fixture();
    const base = await f.digest();
    expect((await f.digest({ now: NOW + 900_000 })).inputHash).toBe(base.inputHash);
    await f.spore('decision', 'a spore landed');
    expect((await f.digest()).inputHash).not.toBe(base.inputHash);
  });
});
