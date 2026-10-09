/**
 * Meta gate: the member binary registers no timer that schedules work.
 *
 * Recurring Deployment work goes through the server wake tick. The member's side
 * of 2.0 is hook-invoked and verb-invoked: a hook fires, a person runs a verb, a
 * worker holds a run it claimed. Nothing on the machine wakes itself up to do
 * work later — the 1.4 PowerManager and its machine-side jobs retire with the
 * daemon — and the machine-side needs that survive are on-demand verbs:
 * `myco doctor` detects installed agents, `myco update` reconciles managed
 * files, `myco upgrade --check` resolves the channel target.
 *
 * SCOPE. This walks the import closure of the 2.0 member entry points only:
 * the hook entries (`src/hooks/**`), the member seam (`src/member/**`) and the
 * worker runner (`src/runner/**`). The `src/daemon/**` tree and the 1.4 CLI
 * wrappers that still reach it through `cli/shared.ts` are 1.4 code that the
 * sweep deletes; a timer there is the daemon's, not the member's. A gate that
 * included them would report the daemon's own loops and prove nothing about the
 * thin binary.
 *
 * The closure is walked, not grepped: a timer two hops deep compiles into the
 * same binary as a direct one. Edges and comment-free code come from the
 * runtime's own parser (`tests/helpers/import-closure.ts`).
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { closureOf, codeOf, entryFiles, moduleKey, pathToEntry, REPO_ROOT, runtimeEdges } from '../helpers/import-closure.ts';

const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');

/** The 2.0 member entry points, as paths under `packages/myco/src` (`/**` = every file under). */
const MEMBER_ENTRIES: readonly string[] = ['hooks/**', 'member/**', 'runner/**'];

/**
 * The timers the member closure may hold: how MANY call sites each module has,
 * and the form that ends them.
 *
 * `cleared` — the module clears every handle it sets, so the timer dies with the
 * work that armed it. `awaited` — the timer only resolves a promise the caller is
 * waiting on, so it cannot outlive that await.
 *
 * The COUNT is what the gate enforces, and it is the point: prose about what
 * bounds a timer is not a fact a test can read, while a new call site in an
 * already-allowlisted module moves a number. Both halves are checked — the count
 * exactly, and enough clears or awaits to account for every site.
 *
 * Every admitted timer is bounded by the active request or claimed attempt,
 * or by a caller waiting between requests. Each entry pins its termination.
 */
const BOUNDED_TIMERS: Readonly<Record<string, { calls: number; form: 'cleared' | 'awaited'; bound: string }>> = {
  'packages/myco/src/member/capture.ts': {
    calls: 1, form: 'awaited', bound: "a hook delivering in-process waits on another holder of the helper lock, while its marks wait, inside the hook's own budget",
  },
  'packages/myco/src/member/helper.ts': {
    calls: 1, form: 'awaited', bound: "a helper's poll for new work while it lingers, inside its own deadline, injectable by a caller",
  },
  'packages/myco/src/member/transport.ts': {
    calls: 2, form: 'cleared', bound: 'request deadlines that abort HTTP calls',
  },
  'packages/myco/src/member/import.ts': {
    calls: 1, form: 'awaited', bound: 'the wait between passes of an import the Deployment rate-limited, capped per wait and in number, injectable by a caller',
  },
  'packages/myco/src/member/join-code.ts': {
    calls: 1, form: 'awaited', bound: 'the sleep between polls of one join code, injectable by a caller',
  },
  'packages/myco/src/runner/loop.ts': {
    calls: 5, form: 'cleared', bound: "one claimed run's budget, lease heartbeat, accepted lease expiry and cleanup bound, and the sleep between empty claims",
  },
  'packages/myco/src/runner/process-group.ts': {
    calls: 1, form: 'awaited', bound: "the waits while a stopped harness's process group ends, bounded by the stop's grace",
  },
  'packages/myco/src/runner/update-helper.ts': {
    calls: 1, form: 'awaited', bound: 'one supervised update waits within finite handoff, contact and probation deadlines',
  },
  'packages/myco/src/utils/git.ts': {
    calls: 1, form: 'cleared', bound: 'a one-shot Git child deadline, cleared on exit or spawn failure',
  },
};

/**
 * The request deadlines the member closure may hold: `AbortSignal.timeout`, by
 * module, at the count each module has.
 *
 * A deadline is a timer the runtime keeps. It is allowed only as the deadline of
 * a request or a child: every site must be the signal a call is given, alone or
 * joined to the caller's own (`AbortSignal.any([signal, AbortSignal.timeout(…)])`),
 * so it cannot fire on anything but the call it bounds. Like the list above, this
 * only shrinks. The runner idle-loop release request and its finite handoff
 * watcher are the explicit exception; member updates remain on-demand.
 */
const REQUEST_DEADLINES: Readonly<Record<string, { calls: number; bound: string }>> = {
  'packages/myco/src/member/join-code.ts': { calls: 1, bound: 'one poll of a join code' },
  'packages/myco/src/runner/drivers/acp.ts': { calls: 1, bound: "the listing of the run's own tools" },
  'packages/myco/src/runner/loop.ts': { calls: 1, bound: "one worker request (claim, renewal, end), through the loop's one helper" },
  'packages/myco/src/runner/models.ts': { calls: 1, bound: "one listing of a harness's models" },
  'packages/myco/src/runner/repository-checkout.ts': { calls: 1, bound: "one run's source checkout request" },
  'packages/myco/src/runner/repository.ts': { calls: 1, bound: "one run's source checkout" },
  'packages/myco/src/runner/update.ts': { calls: 1, bound: 'one release-discovery HTTP request at an idle update check' },
};

/** A repeating timer is allowed only where a run holds it, and only if the same module ends it. */
const REPEATING_TIMER = 'packages/myco/src/runner/loop.ts';

/**
 * Timer identifiers and sleeps are checked after transpilation.
 * Plain globalThis.fetch calls are allowed in the member closure. Computed
 * global access and casts are checked in raw source; transpilation erases casts.
 * This raw-source check also matches comments containing those access forms.
 * A two-statement computed access with no cast or timer identifier is outside
 * this scan's coverage and remains subject to TypeScript's indexing checks.
 */
const TIMER_IDENTIFIERS = /\b(setInterval|setTimeout|setImmediate)\b|Bun\.sleep|scheduler\.wait/;
const GLOBAL_REACH = /globalThis\b\s+as\b|globalThis\b(?:\s+as\b[^[\n]{0,80})?\s*\)?\s*\[/;
/** Call sites, counted: the identifier applied to arguments. */
const TIMER_CALL = /\b(setInterval|setTimeout|setImmediate)\s*\(|Bun\.sleep\s*\(|scheduler\.wait\s*\(/g;
const TIMER_CLEARED = /\b(clearInterval|clearTimeout)\s*\(/g;
const TIMER_AWAITED = /new Promise[\s\S]{0,160}?(set(Interval|Timeout)|Bun\.sleep)\s*\(/g;
/**
 * A deadline, in the spellings this gate reads: through the property, optional
 * or not, or through a computed name. `AbortSignal` itself taken apart or handed
 * on under another name (`DEADLINE_ALIAS`) is refused outright, so a deadline is
 * only ever spelled where these patterns see it.
 */
const DEADLINE_IDENTIFIER = /\bAbortSignal\s*(?:\??\.\s*timeout\b|(?:\?\.)?\[\s*['"`]timeout['"`]\s*\])/;
const DEADLINE_CALL = /\bAbortSignal\s*(?:\??\.\s*timeout|(?:\?\.)?\[\s*['"`]timeout['"`]\s*\])\s*(?:\?\.)?\(/g;
const DEADLINE_ALIAS = /(?:=|:|\(|,|return)\s*AbortSignal\s*(?:[;,)\n]|$)|\}\s*=\s*AbortSignal\b/m;
/** A deadline given to a call: joined to the caller's signal, or passed as a call's own `signal`. */
const DEADLINE_BOUND = /AbortSignal\.any\(\s*\[[^\]]*?AbortSignal\.timeout\(|\bsignal\s*:[^,\n]*?AbortSignal\.timeout\(/g;

/** What a machine-side scheduler is made of; none of it may be reachable from a member entry. */
const SCHEDULER_TOKENS: readonly RegExp[] = [/\bPowerManager\b/, /\bJobRunner\b/, /\bPOWER_JOB_NAMES\b/, /\bregisterJob\s*\(/];

const CLOSURE = closureOf(entryFiles(SRC, MEMBER_ENTRIES));
const SOURCE = new Map([...CLOSURE.modules].map(([key, file]) => [key, fs.readFileSync(file, 'utf-8')]));
const CODE = new Map([...SOURCE].map(([key, source]) => [key, codeOf(source, key)]));

describe('the 2.0 member entry graph', () => {
  it('walks a closure worth gating', () => {
    expect(CLOSURE.modules.size).toBeGreaterThan(50);
    expect([...CLOSURE.unknowable.keys()]).toEqual([]);
  });

  it('reaches no daemon module and names no scheduler', () => {
    const daemon = [...CLOSURE.modules.keys()].filter((key) => key.includes('/src/daemon/'));
    expect(daemon.map((key) => pathToEntry(CLOSURE, key).join(' -> '))).toEqual([]);
    const naming: string[] = [];
    for (const [key, code] of CODE) {
      if (SCHEDULER_TOKENS.some((token) => token.test(code))) naming.push(pathToEntry(CLOSURE, key).join(' -> '));
    }
    expect(naming).toEqual([]);
  });

  it('names a timer in no module but the allowlisted ones, whatever the spelling', () => {
    const naming = [...CODE].filter(([, code]) => TIMER_IDENTIFIERS.test(code)).map(([key]) => key);
    expect(naming.sort()).toEqual(Object.keys(BOUNDED_TIMERS).sort());
  });

  it('holds a request deadline in no module but the allowlisted ones, in any spelling this gate reads', () => {
    const naming = [...CODE].filter(([, code]) => DEADLINE_IDENTIFIER.test(code)).map(([key]) => key);
    expect(naming.sort()).toEqual(Object.keys(REQUEST_DEADLINES).sort());
  });

  it('never takes `AbortSignal` apart or passes it on under another name, so no deadline escapes those spellings', () => {
    const aliasing = [...CODE].filter(([, code]) => DEADLINE_ALIAS.test(code)).map(([key]) => key);
    expect(aliasing).toEqual([]);
  });

  it('reads each spelling of a deadline, and each way of taking `AbortSignal` apart', () => {
    for (const spelled of ['AbortSignal.timeout(5)', 'AbortSignal?.timeout(5)', "AbortSignal['timeout'](5)", 'AbortSignal?.["timeout"](5)']) {
      expect({ spelled, named: DEADLINE_IDENTIFIER.test(spelled), calls: (spelled.match(DEADLINE_CALL) ?? []).length }).toEqual({ spelled, named: true, calls: 1 });
    }
    for (const aliased of ['const { timeout } = AbortSignal;', 'const S = AbortSignal;', 'use(AbortSignal)', 'return AbortSignal;']) {
      expect({ aliased, refused: DEADLINE_ALIAS.test(aliased) }).toEqual({ aliased, refused: true });
    }
    expect(DEADLINE_ALIAS.test('AbortSignal.any([signal, AbortSignal.timeout(5)])')).toBe(false);
  });

  it('gives every request deadline to the call it bounds, at the count the allowlist declares', () => {
    for (const [key, { calls }] of Object.entries(REQUEST_DEADLINES)) {
      const code = CODE.get(key);
      expect({ key, present: code !== undefined }).toEqual({ key, present: true });
      const sites = (code!.match(DEADLINE_CALL) ?? []).length;
      const bound = (code!.match(DEADLINE_BOUND) ?? []).length;
      expect({ key, sites, bound }).toEqual({ key, sites: calls, bound: calls });
    }
  });

  it('reaches into the global object for nothing but a plain member, so a name assembled at runtime has nowhere to land', () => {
    const reaching = [...SOURCE].filter(([, source]) => GLOBAL_REACH.test(source)).map(([key]) => key);
    expect(reaching).toEqual([]);
  });

  it('accounts for every timer call site with a clear or an await, at the count the allowlist declares', () => {
    for (const [key, { calls, form }] of Object.entries(BOUNDED_TIMERS)) {
      const code = CODE.get(key);
      expect({ key, present: code !== undefined }).toEqual({ key, present: true });
      const sites = (code!.match(TIMER_CALL) ?? []).length;
      const accounted = (code!.match(form === 'cleared' ? TIMER_CLEARED : TIMER_AWAITED) ?? []).length;
      expect({ key, sites, accountedFor: accounted >= sites }).toEqual({ key, sites: calls, accountedFor: true });
    }
  });

  it('repeats a timer only for a run the worker holds, and ends it in the same module', () => {
    const repeating = [...CODE].filter(([, code]) => /\bsetInterval\s*\(/.test(code)).map(([key]) => key);
    expect(repeating).toEqual([REPEATING_TIMER]);
    expect(CODE.get(REPEATING_TIMER)).toContain('clearInterval(');
  });
});

/**
 * The machine-side survivors, as verbs.
 *
 * Each need the 1.4 JobRunner woke up to do is answered by a command someone
 * runs — a person, the installer, or the setup skill. The verb's OWN edges are
 * read, not its whole closure: a module reachable somewhere under a 230-module
 * CLI graph proves nothing about what the verb does, while the import the verb
 * itself makes and the symbol it names are the work.
 *
 * WHAT THIS HOLDS, exactly: that the verb reaches the work, and that the member
 * schedules none of these verbs. It does NOT hold that the verb performs it — a
 * body replaced by an early return leaves both the edge and the symbol in place.
 * `tests/cli/doctor-agents.test.ts` holds the behaviour for detection, by driving
 * the verb's check surface over a project tree and reading back the agent it
 * found. The other two verbs write to the machine or call the network, so they
 * are held structurally here and behaviourally by whoever owns their rework.
 */
const SURVIVOR_VERBS: ReadonlyArray<{ need: string; verb: string; imports: string; names: string }> = [
  { need: 'symbiont detection', verb: 'cli/doctor.ts', imports: '../symbionts/detect.js', names: 'detectSymbionts' },
  { need: 'member setup refresh', verb: 'cli/update.ts', imports: '../member/refresh-setup.js', names: 'refreshMemberSetup' },
  { need: 'the release check', verb: 'cli/update.ts', imports: '../upgrade/release-resolver.js', names: 'resolveMycoBinaryUpdateRefs' },
];

describe('the machine-side survivors are on-demand verbs', () => {
  for (const { need, verb, imports, names } of SURVIVOR_VERBS) {
    it(`answers ${need} in \`myco ${path.basename(verb, '.ts')}\``, () => {
      const file = path.join(SRC, verb);
      const source = fs.readFileSync(file, 'utf-8');
      const edges = runtimeEdges(source, file);
      expect({ need, imports: edges.specifiers.includes(imports), names: codeOf(source, file).includes(names) })
        .toEqual({ need, imports: true, names: true });
      // And the verb is no part of what the member schedules.
      expect(CLOSURE.modules.has(moduleKey(file))).toBe(false);
    });
  }

  it('offers the upgrade check as a flag rather than a cadence', () => {
    expect(fs.readFileSync(path.join(SRC, 'cli', 'update.ts'), 'utf-8')).toContain("{ name: '--check' }");
  });
});
