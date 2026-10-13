import { it, expect } from 'bun:test';
import { run } from '@myco/cli/setup.js';
import { legacyJourney, LEGACY_URLS } from './legacy-journey.js';

it('legacy setup requires an injected service runner', async () => {
  const fixture = await legacyJourney(process.env.MYCO_SETUP_FIXTURE_ROOT!);
  if (process.env.MYCO_NATIVE_SERVICE_STUB !== '1') delete process.env.MYCO_LAUNCH_AGENTS_DIR;
  try {
    const code = await run(['--join', LEGACY_URLS[0], '--cutover', '--yes', '--no-agents', '--no-runner'], {
      ...fixture.deps, cutoverDeps: { ...fixture.deps.cutoverDeps,
        ...(process.env.MYCO_NATIVE_SERVICE_STUB === '1' ? {} : { launchctl: undefined }),
      },
    });
    expect(code).toBe(0);
  } finally { await fixture.close(); }
});
