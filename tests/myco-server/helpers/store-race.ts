import { inheritStoreContext, type PreparedStatement, type RelationalStore } from '@myco-server-worker/core/adapters.js';
import { createProject } from '@myco-server-worker/db/storage/projects.js';

/**
 * Two writers racing on one store, and the Deployment rows the race cases share. Imported by the cases that run both
 * natively and inside workerd, so it holds no test-runner or Bun import.
 */

export type Writer<T> = (db: RelationalStore) => Promise<T>;

/**
 * Runs two writers against one store with their store calls strictly alternating, `first` making the first one,
 * whatever SQL either sends; a writer that finishes hands the store to the other. That is one interleaving per start
 * order: for writers that commit in one batch it is each commit order, and a writer of several calls needs `sweep`
 * as well, which puts each writer's whole run between every pair of the other's calls. Answers both writers' results.
 */
export async function lockstep<A, B>(db: RelationalStore, first: Writer<A>, second: Writer<B>): Promise<[A, B]> {
  let turn = 0;
  const finished = [false, false];
  const parked: Array<(() => void) | undefined> = [undefined, undefined];
  const handTo = (side: number): void => {
    turn = side;
    const resume = parked[side];
    parked[side] = undefined;
    resume?.();
  };
  const step = async <T>(side: number, call: () => Promise<T>): Promise<T> => {
    if (turn !== side && !finished[1 - side]) await new Promise<void>((resume) => { parked[side] = resume; });
    try { return await call(); } finally { if (!finished[1 - side]) handTo(1 - side); }
  };
  const storeFor = (side: number): RelationalStore => {
    const originals = new WeakMap<PreparedStatement, PreparedStatement>();
    const wrap = (statement: PreparedStatement): PreparedStatement => {
      const wrapped: PreparedStatement = {
        bind: (...values) => wrap(statement.bind(...values)),
        first: <T>() => step(side, () => statement.first<T>()),
        all: <T>() => step(side, () => statement.all<T>()),
        run: () => step(side, () => statement.run()),
      };
      originals.set(wrapped, statement);
      return wrapped;
    };
    return inheritStoreContext(db, {
      prepare: (sql) => wrap(db.prepare(sql)),
      batch: (statements) => step(side, () => db.batch(statements.map((statement) => originals.get(statement) ?? statement))),
    });
  };
  const run = async <T>(side: number, writer: Writer<T>): Promise<T> => {
    try { return await writer(storeFor(side)); } finally { finished[side] = true; handTo(1 - side); }
  };
  return Promise.all([run(0, first), run(1, second)]);
}

/**
 * Runs `first` until it has made `calls` store calls, then the whole of `second`, then the rest of `first`: sweeping
 * `calls` from zero puts `second` between every pair of `first`'s calls. Answers both results, and whether `second`
 * ran before `first` finished (false once `calls` is past `first`'s last call).
 */
export async function interleaveAt<A, B>(db: RelationalStore, first: Writer<A>, second: Writer<B>, calls: number): Promise<{ results: [A, B]; inside: boolean }> {
  let made = 0;
  let other: Promise<B> | undefined;
  const before = async (): Promise<void> => {
    if (made++ === calls) await (other = second(db));
  };
  const originals = new WeakMap<PreparedStatement, PreparedStatement>();
  const wrap = (statement: PreparedStatement): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: async <T>() => { await before(); return statement.first<T>(); },
      all: async <T>() => { await before(); return statement.all<T>(); },
      run: async () => { await before(); return statement.run(); },
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  const result = await first(inheritStoreContext(db, {
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: async (statements) => { await before(); return db.batch(statements.map((statement) => originals.get(statement) ?? statement)); },
  }));
  const inside = other !== undefined;
  return { results: [result, await (other ?? second(db))], inside };
}

export interface Sweep<A, B> {
  left: (run: number) => Writer<A>;
  right: (run: number) => Writer<B>;
  /** Brings the store to the race's starting state before a run. */
  before?: (run: number) => Promise<void>;
  /** Checks one run's outcome; `at` names where the inserted writer ran. */
  after: (run: number, results: [A, B], at: string) => Promise<void>;
}

/**
 * Puts each writer's whole run between every pair of the other's store calls, in both directions: `interleaveAt` swept
 * from zero until the inserted writer runs after the other finished. Each run gets its own run number.
 */
export async function sweep<A, B>(db: RelationalStore, race: Sweep<A, B>): Promise<void> {
  let run = 0;
  for (const leftFirst of [true, false]) {
    for (let calls = 0, inside = true; inside; calls += 1, run += 1) {
      await race.before?.(run);
      if (leftFirst) {
        const outcome = await interleaveAt(db, race.left(run), race.right(run), calls);
        inside = outcome.inside;
        await race.after(run, outcome.results, `right before left's call ${calls}`);
      } else {
        const outcome = await interleaveAt(db, race.right(run), race.left(run), calls);
        inside = outcome.inside;
        await race.after(run, [outcome.results[1], outcome.results[0]], `left before right's call ${calls}`);
      }
    }
  }
}

/** Runs the race twice, once with each writer first, answering the results of each run in writer order. */
export async function bothOrders<A, B>(db: RelationalStore, left: (order: number) => Writer<A>, right: (order: number) => Writer<B>): Promise<Array<[A, B]>> {
  const ahead = await lockstep(db, left(0), right(0));
  const [rightFirst, leftSecond] = await lockstep(db, right(1), left(1));
  return [ahead, [leftSecond, rightFirst]];
}

export function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

export function equal(actual: unknown, expected: unknown, message: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

export async function rows<T = Record<string, unknown>>(db: RelationalStore, sql: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...values).all<T>()).results;
}

export const PROJECT = 'p';
export const MEMBER = 'member';
export const MACHINE = 'machine';

/** A Project created as the operator creates one, and a member whose machine has joined. */
export async function seedDeployment(db: RelationalStore): Promise<void> {
  check(await createProject(db, PROJECT, 'Project', 0), 'the race Project is created');
  await db.batch([
    db.prepare('INSERT INTO members(id,label,created_at) VALUES (?1,?1,0)').bind(MEMBER),
    db.prepare('INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES (?1,?2,0)').bind(MACHINE, MEMBER),
  ]);
}
