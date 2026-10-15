import { it, expect } from 'bun:test';
import { run } from '@myco/cli/setup.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { LEGACY_URLS } from './legacy-journey.js';
import { legacyInterruption } from './legacy-interruption.js';

it('stops the legacy journey for a parent-owned SIGKILL', async () => {
  const fixture = await legacyInterruption(process.env.MYCO_SETUP_FIXTURE_ROOT!, {
    boundary: process.env.MYCO_SETUP_STOP_AFTER, growth: !!process.env.MYCO_SETUP_GROW,
  });
  try {
    expect(await run(['--join', LEGACY_URLS[0], '--cutover', '--no-runner', '--yes'], fixture.deps)).toBe(0);
    expect(legacyMigrationState(fixture.legacy.mycoHome).state).toBe('moved');
  } finally { await fixture.close(); }
}, 30_000);
