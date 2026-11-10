import { inheritStoreContext, type PreparedStatement, type RelationalStore } from '@myco-server-worker/core/adapters.js';
import { definedStatements } from '@myco-server-worker/db/kernel/statement.js';

/**
 * Faults at the store boundary for crash, failure and race tests. A fault is placed by when a call happens — the n-th
 * call an operation makes — so a test can sweep every point of an operation, never by the SQL a call carries. A call is
 * one round trip to the store: a statement's `run`, `all` or `first`, or one `batch`. Where a test needs one particular
 * write to fail, or another request to land at it, `failingStatement` and `changingAtStatement` key on the name the
 * kernel gives that statement.
 */

/** A fault lands before the call reaches the store, or after the store applied it but before the caller hears. */
export type Moment = 'before' | 'after';

/** A wrapped store and the calls made through it so far. */
export interface Watched { readonly store: RelationalStore; calls(): number }

/** What the store does with its n-th call: `apply` sends the call on, and `statements` names the SQL of what it carries. */
type Step = <T>(n: number, statements: readonly (string | undefined)[], apply: () => Promise<T>) => Promise<T>;

function around(db: RelationalStore, step: Step): Watched {
  let calls = 0;
  const held = new WeakMap<PreparedStatement, { raw: PreparedStatement; sql: string }>();
  const wrap = (raw: PreparedStatement, sql: string): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(raw.bind(...values), sql),
      first: <T>() => step(++calls, [sql], () => raw.first<T>()),
      all: <T>() => step(++calls, [sql], () => raw.all<T>()),
      run: () => step(++calls, [sql], () => raw.run()),
    };
    held.set(wrapped, { raw, sql });
    return wrapped;
  };
  const store = inheritStoreContext(db, {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: (statements) => {
      const originals = statements.map((statement) => held.get(statement));
      return step(++calls, originals.map((original) => original?.sql), () => db.batch(statements.map((statement, index) => originals[index]?.raw ?? statement)));
    },
  });
  return { store, calls: () => calls };
}

const ended = () => new Error('the process ended');

/**
 * A store that dies at its `at`-th call: before that call reaches the store, or after it applied but before the caller
 * hears. Every later call fails too, as calls into a process that has ended would. With `at` at infinity it never dies
 * and only counts the calls a whole operation makes, so a test can then sweep `at` over every one of them.
 */
export function dying(db: RelationalStore, at: number, when: Moment): Watched {
  let dead = false;
  let made = 0;
  const watched = around(db, async (n, _statements, apply) => {
    if (dead) throw ended();
    made = n;
    if (n === at && when === 'before') { dead = true; throw ended(); }
    const result = await apply();
    if (n === at && when === 'after') { dead = true; throw ended(); }
    return result;
  });
  return { store: watched.store, calls: () => made };
}

/** A store that counts the calls made through it: `dying` that never dies. */
export const counting = (db: RelationalStore): Watched => dying(db, Number.POSITIVE_INFINITY, 'before');

/**
 * A store whose `at`-th call alone fails, before it reaches the store or after it applied, while every other call goes
 * through: a transient fault, such as a dropped connection the next request does not see.
 */
export function failingAt(db: RelationalStore, at: number, when: Moment, error: () => Error = () => new Error('the store call failed')): Watched {
  return around(db, async (n, _statements, apply) => {
    if (n === at && when === 'before') throw error();
    const result = await apply();
    if (n === at && when === 'after') throw error();
    return result;
  });
}

/**
 * A store that runs `change` once, just before its `at`-th call reaches the store: another request landing at that
 * point of the operation. `change` may read the store to learn what the operation had already done when it landed.
 */
export function changingAt(db: RelationalStore, at: number, change: () => unknown): Watched & { landed(): boolean } {
  let landed = false;
  const watched = around(db, async (n, _statements, apply) => {
    if (n === at) { landed = true; await change(); }
    return apply();
  });
  return { ...watched, landed: () => landed };
}

/**
 * The calls a fault test covers instead of every one of `total`: the first call, the call that stores the operation's
 * effect and the one after it (`storing`, as `storingCall` finds it), and the last. With no storing call, the first, a
 * middle and the last call.
 */
export function representativePoints(total: number, storing = 0): number[] {
  const points = storing > 0 ? [1, storing, storing + 1, total] : [1, Math.ceil(total / 2), total];
  return [...new Set(points)].filter((at) => at >= 1 && at <= total).sort((a, b) => a - b);
}

/**
 * A change swept over every point of a request that can be repeated on one store: the request runs with `change` landing
 * just before its first call, then its second, and so on. `stored` reads, when the change lands, whether the request had
 * already stored its effect; the sweep ends at the first point where it had, or where the request finished before the
 * change could land. Between points `undo` moves back what the change moved. `check` sees each point's result.
 */
export async function sweepChange<T>(db: RelationalStore, options: {
  request: (store: RelationalStore) => Promise<T>; change: () => unknown; stored: () => unknown; undo: () => unknown;
  check: (result: T, point: { at: number; afterStored: boolean; landed: boolean }) => unknown; limit?: number;
}): Promise<number> {
  for (let at = 1; at <= (options.limit ?? 200); at++) {
    let afterStored = false;
    const landing = changingAt(db, at, async () => { afterStored = Boolean(await options.stored()); await options.change(); });
    const result = await options.request(landing.store);
    await options.check(result, { at, afterStored, landed: landing.landed() });
    if (!landing.landed() || afterStored) return at;
    await options.undo();
  }
  throw new Error(`the change never landed after the request stored, in ${options.limit ?? 200} points`);
}

/**
 * A store that runs `change` once, just before the first call carrying the statement the kernel names `name`: another
 * request landing at that write. `landed` refuses when no kernel statement carries that name.
 */
export function changingAtStatement(db: RelationalStore, name: string, change: () => unknown): { store: RelationalStore; landed(): boolean } {
  let landed = false;
  const watched = around(db, async (_n, statements, apply) => {
    const sql = definedStatements().get(name);
    if (!landed && sql !== undefined && statements.includes(sql)) { landed = true; await change(); }
    return apply();
  });
  return {
    store: watched.store,
    landed: () => {
      if (!definedStatements().has(name)) throw new Error(`no kernel statement is named ${name}`);
      return landed;
    },
  };
}

/**
 * A store that runs `observe` just before each of its calls reaches the store and just after it returns, so a test can
 * read what each call stored. `storingCall` uses it to find the call that writes.
 */
export function observing(db: RelationalStore, observe: (n: number, moment: Moment) => unknown): Watched {
  return around(db, async (n, _statements, apply) => {
    await observe(n, 'before');
    const result = await apply();
    await observe(n, 'after');
    return result;
  });
}

/**
 * The first call of `operation` after which `stored` reads differently than just before it: the call that writes what
 * the operation stores, found by what it stores rather than by the SQL it sends. Zero when the operation stored nothing.
 */
export async function storingCall(db: RelationalStore, operation: (store: RelationalStore) => Promise<unknown>, stored: () => unknown): Promise<number> {
  let first = 0;
  let prior = '';
  const watched = observing(db, async (n, moment) => {
    const now = JSON.stringify(await stored());
    if (moment === 'before') prior = now;
    else if (first === 0 && now !== prior) first = n;
  });
  await operation(watched.store);
  return first;
}

/**
 * A store on which the statement the kernel names `name` fails: the batch or call carrying it fails before it reaches
 * the store, or after it applied, for its first `times` calls (all of them by default). `failures` answers how often it
 * failed, and refuses when no kernel statement carries that name, so a renamed statement fails the test instead of
 * leaving it passing without a fault.
 */
export function failingStatement(
  db: RelationalStore, name: string, options: { when?: Moment; times?: number; error?: () => Error } = {},
): { store: RelationalStore; failures(): number } {
  const { when = 'before', times = Number.POSITIVE_INFINITY, error = () => new Error(`${name} failed`) } = options;
  let failures = 0;
  const watched = around(db, async (_n, statements, apply) => {
    const sql = definedStatements().get(name);
    const fails = sql !== undefined && failures < times && statements.includes(sql);
    if (fails && when === 'before') { failures += 1; throw error(); }
    const result = await apply();
    if (fails && when === 'after') { failures += 1; throw error(); }
    return result;
  });
  return {
    store: watched.store,
    failures: () => {
      if (!definedStatements().has(name)) throw new Error(`no kernel statement is named ${name}`);
      return failures;
    },
  };
}
