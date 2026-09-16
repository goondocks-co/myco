/**
 * The gate the recovery checkpoint mutates behind: mutations one at a time, and one step shared by the wakes that
 * overlap it, so two continuations arriving together ask a provider once.
 */
import { expect, it } from 'bun:test';
import { serialGate } from '@myco-server-worker/core/serial-gate.js';

const deferred = <T>(): { promise: Promise<T>; settle: (value: T) => void; fail: (error: Error) => void } => {
  let settle!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject; });
  return { promise, settle, fail };
};

it('runs one shared step for every caller that arrives while it is in flight', async () => {
  const gate = serialGate();
  const first = deferred<number>();
  let runs = 0;
  const work = async (): Promise<number> => { runs += 1; return first.promise; };
  const a = gate.shared(work);
  const b = gate.shared(work);
  const c = gate.shared(work);
  first.settle(7);
  expect(await Promise.all([a, b, c])).toEqual([7, 7, 7]);
  expect(runs).toBe(1);
  // The next caller after it settles gets a step of its own.
  const second = deferred<number>();
  const later = gate.shared(async () => { runs += 1; return second.promise; });
  second.settle(8);
  expect(await later).toBe(8);
  expect(runs).toBe(2);
});

it('never overlaps mutations, and keeps their order', async () => {
  const gate = serialGate();
  const order: string[] = [];
  let inside = 0;
  const mutate = (name: string) => gate.exclusive(async () => {
    inside += 1;
    expect(inside).toBe(1);
    await Promise.resolve();
    order.push(name);
    inside -= 1;
  });
  await Promise.all([mutate('one'), mutate('two'), mutate('three')]);
  expect(order).toEqual(['one', 'two', 'three']);
});

it('holds a shared step against a mutation, and a failure wedges neither', async () => {
  const gate = serialGate();
  const order: string[] = [];
  const step = deferred<string>();
  const running = gate.shared(async () => { order.push('step:start'); const value = await step.promise; order.push('step:end'); return value; });
  const mutation = gate.exclusive(async () => { order.push('mutation'); });
  step.settle('done');
  expect(await running).toBe('done');
  await mutation;
  expect(order).toEqual(['step:start', 'step:end', 'mutation']);

  await expect(gate.shared(async () => { throw new Error('a step failed'); })).rejects.toThrow('a step failed');
  await expect(gate.exclusive(async () => { throw new Error('a mutation failed'); })).rejects.toThrow('a mutation failed');
  expect(await gate.shared(async () => 'still open')).toBe('still open');
  expect(await gate.exclusive(async () => 'still open')).toBe('still open');
});
