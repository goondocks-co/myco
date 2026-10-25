import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { closureOf, codeOf, filesUnder, moduleKey, REPO_ROOT } from '../helpers/import-closure.ts';

const SERVER = path.join(REPO_ROOT, 'packages/myco-server/src');
const PREFIX = 'packages/myco-server/src/';

/** Modules loaded by operator tools, migrations or fixtures rather than serving entries. */
const NON_SERVING_MODULES: Readonly<Record<string, string>> = {
  'read/view-material-version.ts': 'selected material sequence resolution exercised before reader integration',
  'ingest/view-work-samples.ts': 'dormant committed progress and performance observations exercised by writer tests',
  'ingest/view-flip-work.ts': 'dormant measured whole-flip admission exercised by writer tests',
  'core/material-content.ts': 'dormant material content hash exercised by writer tests',
  'core/material-restore.ts': 'dormant additive material restore exercised by writer tests',
  'core/material-fact-writer.ts': 'dormant authoritative fact mutations exercised by writer tests',
  'core/material-version-backup.ts': 'dormant owned version restore tested before activation',
  'ingest/view-acknowledgements.ts': 'dormant conversion acknowledgement composition tested before activation',
  'ingest/view-projections.ts': 'dormant publication projections tested before activation',
  'ingest/view-terminal.ts': 'dormant instance terminal selection tested before activation',
  'core/material-versions.ts': 'dormant view writer exercised by isolated writer tests',
  'ingest/view-guard.ts': 'dormant view writer exercised by isolated writer tests',
  'ingest/view-checkpoint.ts': 'dormant view writer exercised by isolated writer tests',
  'ingest/view-writer.ts': 'dormant view writer exercised by isolated writer tests',
  'ingest/view-lifecycle.ts': 'dormant view writer exercised by isolated writer tests',
  'ingest/view-build-queue.ts': 'dormant view writer exercised by isolated writer tests',
  'ingest/view-run.ts': 'dormant view job exercised by isolated writer tests',
  'ingest/view-parse.ts': 'dormant view writer exercised by isolated writer tests',
  'ingest/tool-outcome.ts': 'dormant view writer exercised by isolated writer tests',

  'context.ts': 'type declarations consumed by route handlers',
  'core/cost/types.ts': 'type declarations consumed by cost resolution',
  'platform/bun/native.ts': 'type declarations consumed by native storage bootstrap',
  'core/first-owner.ts': 'operator bootstrap: packages/myco/src/server/local-owner.ts and cloudflare-owner.ts',
  'core/recovered-tenant.ts':
    'operator recovery: packages/myco/src/server/local-recovery.ts and cloudflare-recovery.ts',
};

function productionClosure() {
  return closureOf(
    ['index.ts', 'entry/bun.ts', 'platform/bun/server-main.ts'].map((entry) => path.join(SERVER, entry)),
  );
}

describe('server production reachability', () => {
  it('accounts for every server module from the serving entries or an explicit non-serving consumer', () => {
    const reached = productionClosure();
    const loose = filesUnder(SERVER)
      .map(moduleKey)
      .filter((key) => !reached.modules.has(key))
      .map((key) => key.slice(PREFIX.length))
      .sort();
    expect(
      loose.filter((key) => !(key in NON_SERVING_MODULES)),
      'unreachable server modules need a real consumer or removal',
    ).toEqual([]);
    expect(
      Object.keys(NON_SERVING_MODULES).filter((key) => !loose.includes(key)),
      'exclusions must still be unreachable',
    ).toEqual([]);
    for (const reason of Object.values(NON_SERVING_MODULES)) expect(reason.length).toBeGreaterThan(0);
  });

  it('exports no retired run-resume mutations from production source', () => {
    const retired =
      /\b(?:admitResume|classifyFailure|TERMINAL_RESUME_STATUSES|RESUME_MAX_ATTEMPTS|supersedeEquivalentResumableRuns)\b/;
    const exports = filesUnder(SERVER)
      .filter((file) => retired.test(codeOf(fs.readFileSync(file, 'utf8'), file)))
      .map(moduleKey);
    expect(exports, 'failed runs dispatch fresh work; retired resume APIs have no server consumer').toEqual([]);
  });
});

it('the parser entry loads independently of status query initialization', () => {
  const run = Bun.spawnSync(
    [process.execPath, '--no-env-file', '-e', "await import('./packages/myco-server/src/ingest/parse.ts');"],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
});
