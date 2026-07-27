import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Gate: a script that reads a Grove must resolve MYCO_HOME the way every
 * launcher does.
 *
 * `myco`, `myco-run` and the dogfood wrapper resolve `.myco/runtime.home` and
 * export MYCO_HOME before exec, so everything downstream addresses the right
 * install. A script invoked directly skips that layer; without applying the
 * pin itself it silently reads the default `~/.myco` while operating on a
 * Grove belonging to a pinned dev home — reporting on one installation while
 * analysing another.
 *
 * `resolveRuntimeHome` is the shared reader, and it carries the G7 trust check
 * that rejects a group/other-writable or foreign-owned pin. A hand-rolled
 * equivalent would drop that.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

/**
 * Scripts that resolve a Myco home *implicitly* — via `resolveMycoHome`, the
 * MYCO_HOME environment variable, or by walking `<home>/groves`.
 *
 * A script taking an explicit path argument is excluded: it makes no
 * assumption about which install it is addressing, so there is nothing for the
 * pin to correct.
 */
function homeResolvingScripts(): string[] {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => {
      const source = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
      return (
        source.includes('resolveMycoHome')
        || source.includes('MYCO_HOME')
        || /['\`]\.myco['\`]|GROVES_DIRNAME|\/groves/.test(source)
      );
    });
}

describe('scripts honor the runtime home pin', () => {
  it('finds at least one home-resolving script to check', () => {
    // A guard on the guard: if the discovery predicate stops matching, this
    // suite would pass vacuously.
    expect(homeResolvingScripts().length).toBeGreaterThan(0);
  });

  it.each(homeResolvingScripts())('%s applies the pin instead of assuming ~/.myco', (file) => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
    // Importing the resolver is not enough — the result has to reach
    // MYCO_HOME, which is what every launcher does before exec. Asserting only
    // on the identifier would still pass with the call deleted and the import
    // left behind.
    expect(source).toContain('resolveRuntimeHome');
    expect(source).toMatch(/process\.env\.MYCO_HOME\s*=/);
  });

  it('does not hand-roll a runtime.home reader, which would skip the trust check', () => {
    const offenders: string[] = [];
    for (const file of homeResolvingScripts()) {
      const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
      // Reading the pin file directly rather than through the shared resolver.
      if (/readFileSync\([^)]*runtime\.home/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
