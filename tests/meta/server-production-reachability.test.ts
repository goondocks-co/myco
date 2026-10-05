import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { closureOf, codeOf, filesUnder, moduleKey, REPO_ROOT } from '../helpers/import-closure.ts';

const SERVER = path.join(REPO_ROOT, 'packages/myco-server/src');
const PREFIX = 'packages/myco-server/src/';

/** Modules loaded by operator tools, migrations or fixtures rather than serving entries. */
const NON_SERVING_MODULES: Readonly<Record<string, string>> = {
  'context.ts': 'type declarations consumed by route handlers',
  'core/adapters.ts': 'type declarations consumed by storage and platform adapters',
  'core/cost/types.ts': 'type declarations consumed by cost resolution',
  'platform/bun/native.ts': 'type declarations consumed by native storage bootstrap',
  'core/first-owner.ts': 'operator bootstrap: packages/myco/src/server/local-owner.ts and cloudflare-owner.ts',
  'core/cost/index.ts': 'fixture-only barrel: tests/myco-server/cost.test.ts; serving code imports cost modules directly',
  'core/deferred-adapters.ts': 'retirement candidate: notConfigured has no production or fixture consumers',
};

function productionClosure() {
  return closureOf(['index.ts', 'entry/bun.ts', 'platform/bun/server-main.ts'].map((entry) => path.join(SERVER, entry)));
}

describe('server production reachability', () => {
  it('accounts for every server module from the serving entries or an explicit non-serving consumer', () => {
    const reached = productionClosure();
    const loose = filesUnder(SERVER).map(moduleKey).filter((key) => !reached.modules.has(key)).map((key) => key.slice(PREFIX.length)).sort();
    expect(loose.filter((key) => !(key in NON_SERVING_MODULES)), 'unreachable server modules need a real consumer or removal').toEqual([]);
    expect(Object.keys(NON_SERVING_MODULES).filter((key) => !loose.includes(key)), 'exclusions must still be unreachable').toEqual([]);
    for (const reason of Object.values(NON_SERVING_MODULES)) expect(reason.length).toBeGreaterThan(0);
  });

  it('exports no retired run-resume mutations from production source', () => {
    const retired = /\b(?:admitResume|classifyFailure|TERMINAL_RESUME_STATUSES|RESUME_MAX_ATTEMPTS|supersedeEquivalentResumableRuns)\b/;
    const exports = filesUnder(SERVER).filter((file) => retired.test(codeOf(fs.readFileSync(file, 'utf8'), file))).map(moduleKey);
    expect(exports, 'failed runs dispatch fresh work; retired resume APIs have no server consumer').toEqual([]);
  });
});
