/**
 * Step-up authority (#915 L3, #907's boundary).
 *
 * Membership is flat. These are the operations that are not, and the reachable
 * threat is not reading a stored credential — that is already write-only and
 * masked — but changing where the Deployment sends it.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  issueStepUpAuthority, revokeStepUpAuthority, spendStepUpAuthority, stepUpAuthorizer,
  STEP_UP_KEY_PATTERN, STEP_UP_PURPOSES, STEP_UP_TTL_MS,
} from '@myco-server-worker/auth/step-up.js';
import { requiresStepUp, settingsWriter, STEP_UP_LEAVES } from '@myco-server-worker/core/settings.js';
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
    expect(await w.leaves()).toEqual({ 'agent.provider.base_url': 'https://ok.example' });
  });

  it('names as step-up exactly the leaves that decide where a credential goes', () => {
    expect([...STEP_UP_LEAVES].sort()).toEqual(['agent.provider.base_url', 'agent.provider.type', 'embedding.base_url']);
    expect(requiresStepUp('cortex.digest.tier')).toBe(false);
  });
});
