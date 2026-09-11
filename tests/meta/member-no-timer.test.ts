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
 * This list only shrinks. A new module, or a higher count, is a new timer on the
 * machine, and that is the thing this gate exists to make someone argue for.
 */
const BOUNDED_TIMERS: Readonly<Record<string, { calls: number; form: 'cleared' | 'awaited'; bound: string }>> = {
  'packages/myco/src/hooks/session-start.ts': {
    calls: 1, form: 'awaited', bound: "one short re-read of a transcript the IDE writes after the hook fires, inside the hook's own budget",
  },
  'packages/myco/src/member/transport.ts': {
    calls: 2, form: 'cleared', bound: 'request deadlines that abort HTTP calls',
  },
  'packages/myco/src/member/join-code.ts': {
    calls: 1, form: 'awaited', bound: 'the sleep between polls of one join code, injectable by a caller',
  },
  'packages/myco/src/runner/loop.ts': {
    calls: 3, form: 'cleared', bound: "one claimed run's budget, its lease heartbeat, and the sleep between empty claims",
  },
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
  { need: 'managed-files reconcile', verb: 'cli/update.ts', imports: '../symbionts/reconcile.js', names: 'reconcileRegisteredManagedProjectFiles' },
  { need: 'symbiont registration', verb: 'cli/update.ts', imports: './bootstrap.js', names: 'runSymbiontDetection' },
  { need: 'the upgrade check', verb: 'cli/upgrade.ts', imports: '../upgrade/release-resolver.js', names: 'resolveMycoBinaryUpdateRefs' },
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
    expect(fs.readFileSync(path.join(SRC, 'cli', 'upgrade.ts'), 'utf-8')).toContain("{ name: '--check' }");
  });
});
