/**
 * The Settings leaves the dashboard edits, round-tripped one at a time.
 *
 * The silent-data-loss shape this guards is a write that carries a whole document:
 * one field saved, every sibling field overwritten with whatever the form happened
 * to hold. The 2.0 write path cannot take that shape — a write names one leaf and
 * carries one value — and this holds it: each of the leaves the dashboard exposes
 * is written in turn, and after every write each other leaf still reads back the
 * value it held.
 *
 * Driven over the HTTP route rather than against the writer, so the surface, the
 * validated operation and the store are all in the path a form actually takes.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';

/**
 * The leaves §7.8 names as the 2.0 Settings surface, with a value each that
 * satisfies its rule: the session-start instructions, the preferred harness, the
 * transcript retention window, the import bounds, and the per-task ceilings.
 */
const LEAVES: ReadonlyArray<[leaf: string, value: unknown]> = [
  ['instructions.template', '# House rules\n\nRead the ledger first.'],
  ['worker.harness', 'claude-code'],
  ['worker.harness_fallback', ['codex', 'cursor']],
  ['retention.transcripts', 30],
  ['import.enabled', true],
  ['import.window_days', 45],
  ['import.max_sessions_per_harness', 25],
  ['agent.limits.concurrent_runs', 3],
  ['agent.limits.task_concurrent_runs', 1],
  ['agent.limits.task_runs_per_hour', 6],
];

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const put = async (leaf: string, value: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await worker.fetch(new Request(`https://s/api/settings/${encodeURIComponent(leaf)}`, {
      method: 'PUT',
      headers: { cookie: (await asOwner('/')).headers.get('cookie')!, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    }), env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  /** Every leaf the server holds a value for, by name. */
  const stored = async (): Promise<Map<string, unknown>> => {
    const res = await worker.fetch(await asOwner('/api/settings'), env);
    const body = await res.json() as { leaves: Array<{ leaf: string; configured: boolean; value: unknown }> };
    return new Map(body.leaves.filter((l) => l.configured).map((l) => [l.leaf, l.value]));
  };
  return { env, put, stored };
}

describe('the Settings leaves the dashboard exposes', () => {
  it('writes one leaf at a time and leaves every sibling it already held intact', async () => {
    const { put, stored } = await harness();
    const expected = new Map<string, unknown>();
    for (const [leaf, value] of LEAVES) {
      const written = await put(leaf, value);
      expect({ leaf, status: written.status, applied: written.body.applied }).toEqual({ leaf, status: 200, applied: true });
      expected.set(leaf, value);
      // After each write, every leaf written so far still reads back its own value.
      expect({ leaf, stored: Object.fromEntries(await stored()) }).toEqual({ leaf, stored: Object.fromEntries(expected) });
    }
  });

  it('round-trips a second write to one leaf without disturbing the others', async () => {
    const { put, stored } = await harness();
    for (const [leaf, value] of LEAVES) await put(leaf, value);
    const before = await stored();

    expect((await put('retention.transcripts', 0)).body.applied).toBe(true);
    const after = await stored();
    expect(after.get('retention.transcripts')).toBe(0);
    for (const [leaf, value] of before) {
      if (leaf === 'retention.transcripts') continue;
      expect({ leaf, value: after.get(leaf) }).toEqual({ leaf, value });
    }
  });

  it('refuses a value its leaf\'s rule rejects and changes nothing', async () => {
    const { put, stored } = await harness();
    await put('retention.transcripts', 30);
    await put('instructions.template', 'kept');
    const before = Object.fromEntries(await stored());

    const refused = await put('retention.transcripts', 4000);
    expect({ status: refused.status, applied: refused.body.applied, reason: refused.body.reason })
      .toEqual({ status: 400, applied: false, reason: 'invalid_value' });
    expect(Object.fromEntries(await stored())).toEqual(before);
  });

  it('refuses a leaf this tier does not own and changes nothing', async () => {
    const { put, stored } = await harness();
    await put('worker.harness', 'codex');
    const before = Object.fromEntries(await stored());

    const refused = await put('capture.buffer_max_events', 10);
    expect({ status: refused.status, reason: refused.body.reason }).toEqual({ status: 400, reason: 'not_deployment_tier' });
    expect(Object.fromEntries(await stored())).toEqual(before);
  });
});
