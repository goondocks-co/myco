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
 * The timers the member closure may hold, each with what ENDS it. Every one is
 * bounded by something already running: a request, a hook's own read, a run the
 * worker holds. None survives its caller, and none starts work of its own.
 *
 * This list only shrinks. A new entry is a new timer on the machine, and that is
 * the thing this gate exists to make someone argue for.
 */
const BOUNDED_TIMERS: Readonly<Record<string, string>> = {
  'packages/myco/src/hooks/session-start.ts': "one short re-read of a transcript the IDE writes after the hook fires, inside the hook's own budget",
  'packages/myco/src/member/transport.ts': 'the connect and request budgets that abort one HTTP call',
  'packages/myco/src/member/join-code.ts': 'the sleep between polls of one join code, injectable by a caller',
  'packages/myco/src/runner/loop.ts': "one claimed run's budget, its lease heartbeat, and the sleep between empty claims",
};

/** A repeating timer is allowed only where a run holds it, and only if the same module ends it. */
const REPEATING_TIMER = 'packages/myco/src/runner/loop.ts';

/** What a machine-side scheduler is made of; none of it may be reachable from a member entry. */
const SCHEDULER_TOKENS: readonly RegExp[] = [/\bPowerManager\b/, /\bJobRunner\b/, /\bPOWER_JOB_NAMES\b/, /\bregisterJob\s*\(/];

const CLOSURE = closureOf(entryFiles(SRC, MEMBER_ENTRIES));
const CODE = new Map([...CLOSURE.modules].map(([key, file]) => [key, codeOf(fs.readFileSync(file, 'utf-8'), file)]));

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

  it('holds only timers bounded by something already running', () => {
    const withTimer = [...CODE].filter(([, code]) => /\b(setInterval|setTimeout|setImmediate)\s*\(/.test(code)).map(([key]) => key);
    expect(withTimer.sort()).toEqual(Object.keys(BOUNDED_TIMERS).sort());
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
 * itself makes and the symbol it names are exactly the work.
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
