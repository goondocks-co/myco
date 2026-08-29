/**
 * Step-up authority (#915 L3, #907's boundary).
 *
 * Membership is flat. These are the operations that are not, and the reachable
 * threat is not reading a stored credential — that is already write-only and
 * masked — but changing where the Deployment sends it.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import {
  issueStepUpAuthority, revokeStepUpAuthority, spendStepUpAuthority, stepUpAuthorizer,
  STEP_UP_KEY_PATTERN, STEP_UP_PURPOSES, STEP_UP_RETENTION_MS, STEP_UP_TTL_MS,
} from '@myco-server-worker/auth/step-up.js';
import { containsProviderRedirect, DEPLOYMENT_LEAVES, requiresStepUp, settingsWriter, STEP_UP_LEAVES } from '@myco-server-worker/core/settings.js';
import { declaredLeafPaths } from '@myco/config/declared-leaves.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { migrateAndSeed } from './helpers/d1.js';

const NOW = 1_800_000_000_000;

function rig() {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  return { sqlite, db: sqliteRelationalStore(sqlite) };
}

describe('step-up authority', () => {
  it('mints a key of the admitted shape and stores only its digest', async () => {
    const r = rig();
    const issued = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    expect(STEP_UP_KEY_PATTERN.test(issued.key)).toBe(true);
    expect(issued.id.startsWith('su_')).toBe(true);
    expect(issued.expiresAt).toBe(NOW + STEP_UP_TTL_MS);
    expect(JSON.stringify(r.sqlite.query(`SELECT * FROM step_up_authorities`).all())).not.toContain(issued.key);
  });

  it('spends once, and a second presentation is refused', async () => {
    const r = rig();
    const issued = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    expect(await spendStepUpAuthority(r.db, issued.key, 'provider_credential', 'mem_1', NOW)).toEqual({ ok: true, id: issued.id });
    expect(await spendStepUpAuthority(r.db, issued.key, 'provider_credential', 'mem_1', NOW)).toEqual({ ok: false, reason: 'already_used' });
    expect(r.sqlite.query(`SELECT used_by FROM step_up_authorities WHERE id = ?`).get(issued.id)).toEqual({ used_by: 'mem_1' });
  });

  it('admits exactly one winner when two members present one key at once', async () => {
    const r = rig();
    const issued = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    const outcomes = await Promise.all(['mem_1', 'mem_2'].map((m) => spendStepUpAuthority(r.db, issued.key, 'provider_credential', m, NOW)));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
  });

  it('refuses an authority minted for a different operation', async () => {
    // Without the purpose binding, a key handed out to rotate a credential also
    // destroys a Deployment. One token covering four operations reads as
    // protection while granting every one of them.
    const r = rig();
    const issued = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    expect(await spendStepUpAuthority(r.db, issued.key, 'deployment_lifecycle', 'mem_1', NOW)).toEqual({ ok: false, reason: 'wrong_purpose' });
    // And it remains unspent for its own purpose.
    expect(await spendStepUpAuthority(r.db, issued.key, 'provider_credential', 'mem_1', NOW)).toMatchObject({ ok: true });
  });

  it('refuses an expired, revoked, or unknown key by name', async () => {
    const r = rig();
    const expired = await issueStepUpAuthority(r.db, 'provider_credential', NOW - STEP_UP_TTL_MS * 2);
    const revoked = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    expect(await revokeStepUpAuthority(r.db, revoked.id, NOW)).toEqual({ revoked: true });

    expect(await spendStepUpAuthority(r.db, expired.key, 'provider_credential', 'mem_1', NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(await spendStepUpAuthority(r.db, revoked.key, 'provider_credential', 'mem_1', NOW)).toEqual({ ok: false, reason: 'revoked' });
    expect(await spendStepUpAuthority(r.db, 'u'.repeat(43), 'provider_credential', 'mem_1', NOW)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('covers every operation #907 named', () => {
    expect([...STEP_UP_PURPOSES].sort()).toEqual(['deployment_lifecycle', 'enrollment_root_rotation', 'project_reassignment', 'provider_credential']);
  });
});

describe('the settings authorizer', () => {
  const authorized = (r: ReturnType<typeof rig>, key: string | null) =>
    settingsWriter(r.db, { authorize: stepUpAuthorizer(r.db, requiresStepUp, () => key, () => NOW) });

  it('admits an ordinary Deployment setting on membership alone', async () => {
    const r = rig();
    expect(await authorized(r, null).setLeaf('cortex.digest.tier', 5000, 'mem_1', NOW)).toEqual({ applied: true });
  });

  it('refuses an endpoint change with no authority, and stores nothing', async () => {
    // The threat: a member points the Deployment at a host they control, and the
    // Deployment delivers its own provider credential there. Reading the stored
    // secret is not required, and is not the path.
    const r = rig();
    const w = authorized(r, null);
    for (const leaf of STEP_UP_LEAVES) {
      expect(await w.setLeaf(leaf, 'https://attacker.example', 'mem_1', NOW))
        .toEqual({ applied: false, refusal: { reason: 'unauthorized', leaf } });
    }
    expect(await w.leaves()).toEqual({});
  });

  it('admits an endpoint change against a valid authority, once', async () => {
    const r = rig();
    const issued = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    const w = authorized(r, issued.key);

    expect(await w.setLeaf('agent.provider.base_url', 'https://ok.example', 'mem_1', NOW)).toEqual({ applied: true });
    // Single use: the same key does not authorise a second endpoint change.
    expect(await w.setLeaf('embedding.base_url', 'https://also.example', 'mem_1', NOW))
      .toMatchObject({ applied: false, refusal: { reason: 'unauthorized' } });
    expect((await w.leaves())['agent.provider.base_url']?.value).toBe('https://ok.example');
  });

  it('gates a redirect hidden inside a document leaf, not only the leaves named for one', async () => {
    // The bypass this closes: `agent.tasks` is an ungated Deployment leaf whose
    // value is a record of per-task overrides, each of which may carry
    // `provider: { type, base_url }`. Writing it redirects the Deployment's own
    // credential while naming none of the gated leaves. A leaf-name list cannot see
    // that, so the requirement is derived from what the value CONTAINS.
    const r = rig();
    const w = authorized(r, null);
    const redirect = { 'vault-evolve': { provider: { type: 'openai-compatible', base_url: 'https://attacker.example' } } };

    expect(await w.setLeaf('agent.tasks', redirect, 'mem_1', NOW))
      .toEqual({ applied: false, refusal: { reason: 'unauthorized', leaf: 'agent.tasks' } });
    expect(await w.leaves()).toEqual({});

    // The same leaf without a provider block needs no authority.
    expect(await w.setLeaf('agent.tasks', { 'vault-evolve': { reasoningLevel: 'low' } }, 'mem_1', NOW)).toEqual({ applied: true });
  });

  it('sees a redirect at depth, in an array, and under a camelCase key', () => {
    for (const value of [
      { a: { b: { c: { provider: { type: 'openai-compatible' } } } } },
      [{ provider: { base_url: 'https://x' } }],
      { phases: [{ nested: { baseUrl: 'https://x' } }] },
      { deep: { base_url: 'https://x' } },
    ]) {
      expect({ value, gated: containsProviderRedirect(value) }).toEqual({ value, gated: true });
    }
    for (const value of [null, 5, 'a string', { harmless: true }, [1, 2, 3], { reasoningLevel: 'low' }]) {
      expect({ value, gated: containsProviderRedirect(value) }).toEqual({ value, gated: false });
    }
  });

  it('gates every Deployment leaf whose declared schema can carry an endpoint — derived, not listed', () => {
    // The previous form of this asserted STEP_UP_LEAVES equalled its own literal,
    // which cannot fail for a leaf that reaches an endpoint under another name. This
    // walks the declared schema instead: any Deployment leaf that IS an endpoint
    // must be named, and any that can CONTAIN one must be caught by the value rule.
    const endpointLeaves = declaredLeafPaths().filter((l) => /(^|\.)(base_url|baseUrl)$/.test(l));
    for (const leaf of endpointLeaves) {
      if (!DEPLOYMENT_LEAVES.includes(leaf)) continue;
      expect({ leaf, gated: requiresStepUp(leaf) }).toEqual({ leaf, gated: true });
    }
    expect(endpointLeaves.length).toBeGreaterThan(0);
    expect(requiresStepUp('cortex.digest.tier')).toBe(false);
  });
});

describe('step-up retention', () => {
  it('reclaims finished authorities past the window on the next SPEND, and never a live one', async () => {
    const r = rig();
    const old = NOW - STEP_UP_RETENTION_MS - 1;

    const spentLongAgo = await issueStepUpAuthority(r.db, 'provider_credential', old);
    r.sqlite.query(`UPDATE step_up_authorities SET used_at = ? WHERE id = ?`).run(old, spentLongAgo.id);
    const revokedLongAgo = await issueStepUpAuthority(r.db, 'provider_credential', old);
    r.sqlite.query(`UPDATE step_up_authorities SET revoked_at = ? WHERE id = ?`).run(old, revokedLongAgo.id);
    // Expired long ago: issued far enough back that its EXPIRY, not its minting,
    // falls outside the window — the window is measured on the former.
    const expiredLongAgo = await issueStepUpAuthority(r.db, 'provider_credential', old - STEP_UP_TTL_MS);
    const spentRecently = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    r.sqlite.query(`UPDATE step_up_authorities SET used_at = ? WHERE id = ?`).run(NOW, spentRecently.id);
    const live = await issueStepUpAuthority(r.db, 'provider_credential', NOW);

    // The SPEND is what trims. Minting is break-glass — direct store access, no code
    // path through the server — so a sweep hung there never runs on a deployed
    // Deployment at all.
    await spendStepUpAuthority(r.db, live.key, 'provider_credential', 'mem_1', NOW);

    const remaining = (r.sqlite.query(`SELECT id FROM step_up_authorities`).all() as Array<{ id: string }>).map((x) => x.id);
    expect(remaining.sort()).toEqual([spentRecently.id, live.id].sort());
    for (const gone of [spentLongAgo.id, revokedLongAgo.id, expiredLongAgo.id]) expect(remaining).not.toContain(gone);
  });

  it('reclaims nothing when nothing is finished', async () => {
    const r = rig();
    const live = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    const other = await issueStepUpAuthority(r.db, 'provider_credential', NOW);
    await spendStepUpAuthority(r.db, other.key, 'provider_credential', 'mem_1', NOW);
    expect((r.sqlite.query(`SELECT COUNT(*) c FROM step_up_authorities`).get() as any).c).toBe(2);
    expect(r.sqlite.query(`SELECT id FROM step_up_authorities WHERE id = ?`).get(live.id)).toEqual({ id: live.id });
  });

  it('is reached by the path a deployed server actually takes', () => {
    // Minting has no caller under src by design, so a sweep hung on it would be dead
    // code on every real Deployment while the tests looked green.
    const src = readFileSync(new URL('../../packages/myco-server/src/auth/step-up.ts', import.meta.url), 'utf8');
    const spend = src.slice(src.indexOf('export async function spendStepUpAuthority'));
    expect(spend).toContain('reclaimStepUpAuthorities');
  });
});
