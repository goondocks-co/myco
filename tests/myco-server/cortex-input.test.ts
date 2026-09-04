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
  buildInstructionsInput, CONTENT_PREVIEW_MAX_CHARS, DIGEST_EXCERPT_MAX_CHARS, preview,
  RECENT_PLAN_LIMIT, RECENT_SESSION_LIMIT, RECENT_WISDOM_SPORE_LIMIT,
} from '@myco-server-worker/core/cortex-input.js';
import { recallLeaves, type RecallLeaves } from '@myco-server-worker/core/recall.js';
import { SERVED_TOOLS } from '@myco-server-worker/core/tool-catalogue.js';
import { upsertDigest } from '@myco-server-worker/core/digests.js';
import { insertSpore } from '@myco-server-worker/core/spores.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteEnv } from './helpers/fixtures.js';

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
      content, context: null, filePath: null, tags: null, contentHash: null, properties: null, createdAt: NOW - seq,
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
  return { ...e, session, spore, plan, leaf, build };
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

describe('the instructions input', () => {
  it('carries the 1.4 limits and counts what it read', async () => {
    const f = fixture();
    for (let i = 0; i < RECENT_SESSION_LIMIT + 3; i += 1) f.session(`Session ${i}`, `summary ${i}`);
    for (let i = 0; i < RECENT_WISDOM_SPORE_LIMIT + 2; i += 1) await f.spore('wisdom', `wisdom ${i}`);
    for (let i = 0; i < RECENT_PLAN_LIMIT + 2; i += 1) f.plan(`Plan ${i}`, `- [ ] step ${i}`);
    const built = await f.build();
    expect(built.counts).toEqual({ sessions: RECENT_SESSION_LIMIT, spores: RECENT_WISDOM_SPORE_LIMIT, plans: RECENT_PLAN_LIMIT });
    expect(built.instruction).toContain('## Recent sessions');
    expect(built.instruction).toContain('Session 0');
    expect(built.instruction).not.toContain('Session 8');
    expect(built.instruction).toContain('## Recent decision spores');
    expect(built.instruction).toContain('No recent decision spores are available.');
  });

  it('cuts the digest excerpt at its own bound and names the tier it read', async () => {
    const f = fixture();
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: 'myco-agent', tier: 5000, content: 'x'.repeat(DIGEST_EXCERPT_MAX_CHARS * 2), substrateHash: null, generatedAt: NOW });
    const built = await f.build();
    expect(built.instruction).toContain('Tier 5000 digest excerpt:');
    const excerpt = built.instruction.split('Tier 5000 digest excerpt:\n')[1]!.split('\n')[0]!;
    expect(excerpt.length).toBeLessThanOrEqual(DIGEST_EXCERPT_MAX_CHARS + 1);
  });

  it('names the tools this Deployment serves, and no others', async () => {
    const built = await fixture().build();
    for (const name of SERVED_TOOLS) expect(built.instruction).toContain(`\`${name}\``);
    expect(built.instruction).not.toContain('vault_search_fts');
    expect(built.instruction).not.toContain('myco_remember');
  });

  it('renders the runtime config from the leaves recall resolves', async () => {
    const f = fixture();
    const built = await f.build();
    expect(built.instruction).toContain('"digest_tier": 5000');
    expect(built.instruction).toContain('"instructions_inject_on_session_start": true');
  });
});

describe('the input hash', () => {
  it('is the hash of the prompt itself, so every line the model reads is covered', async () => {
    const f = fixture();
    f.session('One', 'first');
    const built = await f.build();
    expect(built.inputHash).toBe(await sha256Hex(built.instruction));
    // The static prose is inside that: the guidance lines and the authoring
    // requirements are part of the prompt, so an edit to either moves the hash
    // with no second constant to remember to bump.
    expect(built.instruction).toContain('## Authoring requirements');
    expect(built.instruction).toContain('## Tool guidance to encode');
  });

  it('stands still over the same material and never carries the clock', async () => {
    const f = fixture();
    f.session('One', 'first');
    const first = await f.build();
    const second = await f.build({ now: NOW + 86_400_000 });
    expect(second.inputHash).toBe(first.inputHash);
  });

  it('moves on a new session, a new spore, a new plan and a new digest', async () => {
    const f = fixture();
    const seen = new Set<string>();
    seen.add((await f.build()).inputHash);
    f.session('One', 'first');
    seen.add((await f.build()).inputHash);
    await f.spore('decision', 'we chose the queue');
    seen.add((await f.build()).inputHash);
    f.plan('Plan one', 'do the thing');
    seen.add((await f.build()).inputHash);
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: 'myco-agent', tier: 5000, content: 'the digest', substrateHash: null, generatedAt: NOW });
    seen.add((await f.build()).inputHash);
    expect(seen.size).toBe(5);
  });

  it('moves on a leaf and on a capability', async () => {
    const f = fixture();
    const base = await f.build();
    const leafMoved = await f.build({ leaves: { ...LEAVES, digestTier: 10000 } });
    const capabilityMoved = await f.build({ capabilities: { ...CAPABILITIES, cortex: false } });
    expect(leafMoved.inputHash).not.toBe(base.inputHash);
    expect(capabilityMoved.inputHash).not.toBe(base.inputHash);
    expect(leafMoved.inputHash).not.toBe(capabilityMoved.inputHash);
  });

  it('does not move on a session whose end has not landed', async () => {
    const f = fixture();
    const base = await f.build();
    f.sqlite.run(
      `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at)
       VALUES ('proj_1', 'live', 'm1', 'tok_1', ?, ?, 'claude-code', ?)`,
      [NOW, NOW, NOW],
    );
    expect((await f.build()).inputHash).toBe(base.inputHash);
  });
});
