/**
 * R2 gate: the run control plane must not interleave.
 *
 * `phase-loop.ts:1395` dispatches every phase in a wave concurrently via
 * `Promise.allSettled`. Today a read-modify-write across two concurrent phases
 * is safe only because `bun:sqlite` is synchronous — the single-threaded loop
 * cannot interleave work that never yields. An async `RunStore` inserts await
 * points at exactly those boundaries, and the existing suite cannot catch the
 * regression: interleaving is nondeterministic and every current test stays
 * green through it.
 *
 * So this gate does not assert "the suite passes". It reproduces the hazard
 * against a store that genuinely yields, and asserts the wrapper closes it:
 *
 *  1. control  — an unserialized store LOSES a write (the hazard is real)
 *  2. gate     — a serialized store keeps both writes
 *  3. gate     — no two operations overlap
 *  4. gate     — a rejected operation does not wedge the queue
 *
 * Control 1 is what makes 2 meaningful: without it, a passing gate proves only
 * that the test never interleaved, not that the wrapper prevented it.
 */
import { describe, expect, it } from 'bun:test';
import { serializeRunStore, type RunStore } from '@myco/agent/runtime/run-store.js';

const PROJECT_ID = 'proj_test';
const AGENT_ID = 'myco-agent';

/** Store that yields between read and write — what any networked store does. */
function yieldingStore(trace: string[] = []): { store: RunStore; state: Map<string, string>; trace: string[]; overlaps: number } {
  const state = new Map<string, string>();
  const box = { overlaps: 0 };
  let active = 0;

  const enter = async (label: string) => {
    if (active > 0) box.overlaps += 1;
    active += 1;
    trace.push(`+${label}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const leave = (label: string) => {
    active -= 1;
    trace.push(`-${label}`);
  };

  const store = {
    async getState(key: string) {
      await enter('get');
      const value = state.get(key) ?? null;
      leave('get');
      return value === null ? null : { agent_id: AGENT_ID, project_id: PROJECT_ID, key, value, updated_at: 0 };
    },
    async setState(key: string, value: string) {
      await enter('set');
      state.set(key, value);
      leave('set');
    },
    async mutateState(key: string, mutate: (current: string | null) => string | null) {
      await enter('mutate');
      const next = mutate(state.get(key) ?? null);
      if (next !== null) state.set(key, next);
      leave('mutate');
    },
  } as unknown as RunStore;

  return { store, state, trace, get overlaps() { return box.overlaps; } } as never;
}

/** Two concurrent phases appending to a shared key via a get/set PAIR. */
async function twoPhasesAppendUnsafe(store: RunStore, key: string): Promise<void> {
  const phase = async (id: string) => {
    const row = await store.getState(key, PROJECT_ID);
    const current: string[] = row ? JSON.parse(row.value) : [];
    await store.setState(key, JSON.stringify([...current, id]), PROJECT_ID);
  };
  await Promise.all([phase('phase-a'), phase('phase-b')]);
}

/** The same, through the port's atomic read-modify-write. */
async function twoPhasesAppend(store: RunStore, key: string): Promise<void> {
  const phase = (id: string) => store.mutateState(key, (current) => {
    const parsed: string[] = current ? JSON.parse(current) : [];
    return JSON.stringify([...parsed, id]);
  }, PROJECT_ID);
  await Promise.all([phase('phase-a'), phase('phase-b')]);
}

describe('RunStore serialization (R2 gate)', () => {
  it('CONTROL: an unserialized store loses a concurrent write', async () => {
    const harness = yieldingStore();
    await twoPhasesAppendUnsafe(harness.store, 'decisions');

    const survivors: string[] = JSON.parse(harness.state.get('decisions') ?? '[]');
    // Both phases read the empty array before either wrote — last write wins.
    expect(survivors).toHaveLength(1);
    expect(harness.overlaps).toBeGreaterThan(0);
  });

  it('CONTROL: serializing a get/set PAIR still loses a write — a mutex is not enough', async () => {
    const harness = yieldingStore();
    await twoPhasesAppendUnsafe(serializeRunStore(harness.store), 'decisions');

    const survivors: string[] = JSON.parse(harness.state.get('decisions') ?? '[]');
    // Every individual operation ran alone; the SEQUENCE still interleaved.
    expect(survivors).toHaveLength(1);
    expect(harness.overlaps).toBe(0);
  });

  it('keeps both writes through the atomic mutate', async () => {
    const harness = yieldingStore();
    await twoPhasesAppend(serializeRunStore(harness.store), 'decisions');

    const survivors: string[] = JSON.parse(harness.state.get('decisions') ?? '[]');
    expect(survivors).toHaveLength(2);
    expect(survivors).toContain('phase-a');
    expect(survivors).toContain('phase-b');
  });

  it('never overlaps two operations', async () => {
    const harness = yieldingStore();
    await twoPhasesAppend(serializeRunStore(harness.store), 'decisions');

    expect(harness.overlaps).toBe(0);
    // Every enter is immediately followed by its own leave.
    for (let i = 0; i < harness.trace.length; i += 2) {
      expect(harness.trace[i]![0]).toBe('+');
      expect(harness.trace[i + 1]![0]).toBe('-');
    }
  });

  it('does not wedge the queue when an operation rejects', async () => {
    const harness = yieldingStore();
    const store = serializeRunStore({
      ...harness.store,
      getState: async () => { throw new Error('store unavailable'); },
    } as RunStore);

    await expect(store.getState('decisions', PROJECT_ID)).rejects.toThrow('store unavailable');
    // A later operation on the same chain still runs.
    await store.setState('decisions', '["after"]', PROJECT_ID);
    expect(harness.state.get('decisions')).toBe('["after"]');
  });
});
