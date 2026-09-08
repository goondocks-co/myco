/**
 * Deployment Settings — the one validated write path (#915 L2).
 *
 * Every write validates, authorizes, persists, records its actor, and re-arms.
 * The tests below are about that order holding and about the fail-closed default
 * on capability admission, which is the property #428 exists to protect.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { settingsWriter, instructionsTemplate, DEPLOYMENT_LEAVES, INSTRUCTIONS_TEMPLATE_LEAF, PROJECT_CAPABILITIES } from '@myco-server-worker/core/settings.js';
import { INSTRUCTIONS_TEMPLATE_MAX_BYTES } from '@myco-server-worker/constants.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { migrateAndSeed } from './helpers/d1.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';

function rig(opts: Parameters<typeof settingsWriter>[1] = {}) {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  const db = sqliteRelationalStore(sqlite);
  return { sqlite, db, w: settingsWriter(db, opts) };
}

describe('deployment settings', () => {
  it('sets a leaf, records who set it, and reads it back', async () => {
    const r = rig();
    expect(await r.w.setLeaf('cortex.digest.tier', 5000, 'mem_1', 1_000)).toEqual({ applied: true });
    expect(await r.w.leaves()).toEqual({ 'cortex.digest.tier': { value: 5000, updatedAt: 1_000, updatedBy: 'mem_1' } });
    expect(r.sqlite.query(`SELECT updated_by, updated_at FROM deployment_settings WHERE leaf='cortex.digest.tier'`).get())
      .toEqual({ updated_by: 'mem_1', updated_at: 1_000 });
  });

  it('refuses a leaf that is not Deployment tier, storing nothing', async () => {
    const r = rig();
    // `capture.*` is member-local by the §7.8 ledger. A Deployment accepting it is
    // one machine's preference silently becoming everyone's.
    expect(await r.w.setLeaf('capture.buffer_max_events', 99, 'mem_1', 1_000))
      .toEqual({ applied: false, refusal: { reason: 'not_deployment_tier', leaf: 'capture.buffer_max_events' } });
    expect(await r.w.leaves()).toEqual({});
  });

  it('refuses an unknown leaf rather than storing a value nothing reads', async () => {
    const r = rig();
    expect(await r.w.setLeaf('not.a.setting', 1, 'mem_1', 1_000))
      .toMatchObject({ applied: false, refusal: { reason: 'not_deployment_tier' } });
  });

  it('replaces a leaf in place and carries the new actor', async () => {
    const r = rig();
    await r.w.setLeaf('embedding.model', 'bge-m3', 'mem_1', 1_000);
    await r.w.setLeaf('embedding.model', 'other', 'mem_2', 2_000);
    expect((await r.w.leaves())['embedding.model']?.value).toBe('other');
    expect((r.sqlite.query(`SELECT COUNT(*) c FROM deployment_settings`).get() as any).c).toBe(1);
    expect(r.sqlite.query(`SELECT updated_by FROM deployment_settings WHERE leaf='embedding.model'`).get()).toEqual({ updated_by: 'mem_2' });
  });

  it('does not persist or re-arm a write it refuses', async () => {
    // Order is the property: a write that persists before it authorizes has already
    // happened by the time it is refused.
    const rearmed: string[] = [];
    const r = rig({ authorize: async () => false, rearm: async ({ leaf }) => { rearmed.push(leaf); } });
    expect(await r.w.setLeaf('embedding.model', 'x', 'mem_1', 1_000))
      .toEqual({ applied: false, refusal: { reason: 'unauthorized', leaf: 'embedding.model' } });
    expect(await r.w.leaves()).toEqual({});
    expect(rearmed).toEqual([]);
  });

  it('re-arms after persisting, and only for a write that landed', async () => {
    const rearmed: string[] = [];
    const r = rig({ rearm: async ({ leaf }) => { rearmed.push(leaf); } });
    await r.w.setLeaf('agent.scheduled_tasks_enabled', false, 'mem_1', 1_000);
    await r.w.setLeaf('capture.buffer_max_events', 1, 'mem_1', 1_000);
    expect(rearmed).toEqual(['agent.scheduled_tasks_enabled']);
  });

  it('sends every authorization decision the leaf, the value and the actor', async () => {
    // The value travels with the decision: the requirement is derived from it, and a
    // redirect can hide inside a document leaf that names no gated leaf.
    const seen: Array<{ leaf: string; value?: unknown; actor: string }> = [];
    const r = rig({ authorize: async (c) => { seen.push(c); return true; } });
    await r.w.setLeaf('embedding.provider', 'ollama', 'mem_9', 1_000);
    await r.w.setCapability('proj_1', 'cortex', true, 'mem_9', 1_000);
    expect(seen).toEqual([
      { leaf: 'embedding.provider', value: 'ollama', actor: 'mem_9' },
      { leaf: 'project.cortex', actor: 'mem_9' },
    ]);
  });
});

describe('project capability admission', () => {
  it('reads every capability OFF for a Project nothing has admitted', async () => {
    const r = rig();
    expect(await r.w.capabilities('proj_1')).toEqual({ cortex: false, canopy: false, skills: false, vault_evolution: false });
    for (const c of PROJECT_CAPABILITIES) expect(await r.w.capabilityEnabled('proj_1', c)).toBe(false);
  });

  it('admits one capability without admitting the others', async () => {
    const r = rig();
    expect(await r.w.setCapability('proj_1', 'cortex', true, 'mem_1', 1_000)).toEqual({ applied: true });
    expect(await r.w.capabilities('proj_1')).toEqual({ cortex: true, canopy: false, skills: false, vault_evolution: false });
  });

  it('withdraws an admitted capability', async () => {
    const r = rig();
    await r.w.setCapability('proj_1', 'skills', true, 'mem_1', 1_000);
    await r.w.setCapability('proj_1', 'skills', false, 'mem_2', 2_000);
    expect(await r.w.capabilityEnabled('proj_1', 'skills')).toBe(false);
    expect(r.sqlite.query(`SELECT updated_by FROM project_capabilities WHERE project_id='proj_1' AND capability='skills'`).get())
      .toEqual({ updated_by: 'mem_2' });
  });

  it('keeps one Project\'s admission from admitting another', async () => {
    const r = rig();
    await r.w.setCapability('proj_1', 'canopy', true, 'mem_1', 1_000);
    expect(await r.w.capabilityEnabled('proj_2', 'canopy')).toBe(false);
  });

  it('refuses a capability it does not define', async () => {
    const r = rig();
    expect(await r.w.setCapability('proj_1', 'made_up', true, 'mem_1', 1_000))
      .toEqual({ applied: false, refusal: { reason: 'unknown_capability', capability: 'made_up' } });
  });
});

describe('a Project created by ingest', () => {
  it('is admitted to NOTHING — the property #428 exists to protect', async () => {
    // A Project appears from a member's first write, with no provisioning step and
    // no member ceremony. On the member side a new vault is made capture-only by
    // `reseedCaptureOnly()` writing `false` at provision; there is no equivalent
    // moment here, so the default itself has to carry the property. If it does not,
    // every project a member touches silently acquires every cost-bearing feature.
    const e = sqliteEnv();
    const token = (await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now())).token;
    const res = await worker.fetch(new Request('https://s/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', [PROJECT_HEADER]: 'proj_brand_new', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
      body: JSON.stringify(envelope({ eventId: uuid(77) })),
    }), e.env);
    expect((await res.json() as Record<string, unknown>).persisted).toBe(true);
    expect(e.sqlite.query(`SELECT 1 FROM projects WHERE project_id='proj_brand_new'`).get()).not.toBeNull();

    const w = settingsWriter(e.db);
    expect(await w.capabilities('proj_brand_new')).toEqual({ cortex: false, canopy: false, skills: false, vault_evolution: false });
    // And nothing wrote a row on its behalf.
    expect((e.sqlite.query(`SELECT COUNT(*) c FROM project_capabilities`).get() as any).c).toBe(0);
  });
});

describe('the deployment leaf registry', () => {
  it('names only leaves the §7.8 ledger assigns to the Deployment tier', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const ledger = fs.readFileSync('docs/architecture/myco-2.0.md', 'utf8');
    const deployment = new Set<string>();
    for (const line of ledger.split('\n')) {
      const m = line.match(/^\| `([^`]+)` \| \w+ \| Deployment \|/);
      if (m) deployment.add(m[1]);
    }
    expect(deployment.size).toBeGreaterThan(20);
    // Both directions: the runtime cannot accept a leaf the ledger did not assign
    // here, and cannot silently ignore one it did.
    expect([...DEPLOYMENT_LEAVES].sort()).toEqual([...deployment].sort());
  });
});


/**
 * A leaf that carries a rule refuses a value that violates it, at the write.
 *
 * The rule lives on the leaf's declaration, so the refusal is the same whatever
 * surface asked. A leaf shipped with its rule from its first commit has no
 * stored value that predates it, which is what lets its reader parse without a
 * fallback branch.
 */
describe('the instructions template leaf', () => {
  const NOW = 1_700_000_000_000;

  it('accepts Markdown at the ceiling and refuses a byte past it', async () => {
    const { db, w } = rig();
    const atCap = 'a'.repeat(INSTRUCTIONS_TEMPLATE_MAX_BYTES);
    expect(await w.setLeaf(INSTRUCTIONS_TEMPLATE_LEAF, atCap, 'member_1', NOW)).toEqual({ applied: true });
    expect(await instructionsTemplate(db)).toBe(atCap);

    const over = 'a'.repeat(INSTRUCTIONS_TEMPLATE_MAX_BYTES + 1);
    const refused = await w.setLeaf(INSTRUCTIONS_TEMPLATE_LEAF, over, 'member_1', NOW);
    expect(refused).toEqual({ applied: false, refusal: { reason: 'invalid_value', leaf: INSTRUCTIONS_TEMPLATE_LEAF, detail: `expected at most ${INSTRUCTIONS_TEMPLATE_MAX_BYTES} bytes, got ${INSTRUCTIONS_TEMPLATE_MAX_BYTES + 1}` } });
    expect(await instructionsTemplate(db)).toBe(atCap);
  });

  it('measures the ceiling in bytes, not characters', async () => {
    const { w } = rig();
    // Four bytes each, so a quarter of the ceiling in characters exceeds it.
    const wide = '𝄞'.repeat(INSTRUCTIONS_TEMPLATE_MAX_BYTES / 2);
    const answered = await w.setLeaf(INSTRUCTIONS_TEMPLATE_LEAF, wide, 'member_1', NOW);
    expect(answered.applied).toBe(false);
  });

  it('refuses a value that is not Markdown text', async () => {
    const { db, w } = rig();
    for (const value of [42, true, null, { a: 1 }, ['a'], 'has a \u0000 control byte']) {
      const answered = await w.setLeaf(INSTRUCTIONS_TEMPLATE_LEAF, value, 'member_1', NOW);
      expect({ value, applied: answered.applied }).toEqual({ value, applied: false });
    }
    expect(await instructionsTemplate(db)).toBe('');
  });

  it('answers empty where the Deployment has written none', async () => {
    const { db } = rig();
    expect(await instructionsTemplate(db)).toBe('');
  });

  it('leaves every other leaf taking any JSON value', async () => {
    const { w } = rig();
    expect(await w.setLeaf('agent.model', { anything: [1, 2] }, 'member_1', NOW)).toEqual({ applied: true });
  });
});
