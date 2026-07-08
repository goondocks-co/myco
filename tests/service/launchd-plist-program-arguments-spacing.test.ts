/**
 * Tests for the launchd plist renderer.
 *
 * Focus: ProgramArguments must keep a spaced executable/argument path intact.
 * Unlike systemd's whitespace-split ExecStart string, launchd's
 * ProgramArguments is an ARRAY where each <string> element is one argument —
 * so a spaced path is inherently safe AS LONG AS each token lands in its own
 * <string> and is not space-joined. These tests prove the array form already
 * handles spaces correctly (no code change was needed here), and that XML
 * special characters are escaped.
 */

import { describe, test, expect } from 'bun:test';
import { renderLaunchdPlist } from '@myco/service/launchd-plist.js';
import type { ServiceSpec } from '@myco/service/types.js';

function specWith(overrides: Partial<ServiceSpec>): ServiceSpec {
  return {
    label: 'co.goondocks.myco',
    variant: 'prod',
    executable: '/Users/alice/.local/bin/myco',
    args: ['daemon', 'run'],
    workingDir: '/Users/alice',
    env: { MYCO_VARIANT: 'prod' },
    stdoutPath: '/Users/alice/.myco/out.log',
    stderrPath: '/Users/alice/.myco/err.log',
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 2,
    ...overrides,
  };
}

/** Pull the <string> elements out of the ProgramArguments <array> block. */
function programArguments(plist: string): string[] {
  const arrayBlock = plist
    .split('<key>ProgramArguments</key>')[1]
    ?.split('</array>')[0];
  expect(arrayBlock).toBeDefined();
  return [...arrayBlock!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

describe('renderLaunchdPlist ProgramArguments spacing', () => {
  test('a spaced executable path is a SINGLE array element, not split', () => {
    const plist = renderLaunchdPlist(
      specWith({ executable: '/Users/alice smith/.local/bin/myco' }),
    );
    const argv = programArguments(plist);
    expect(argv[0]).toBe('/Users/alice smith/.local/bin/myco');
    expect(argv).toEqual([
      '/Users/alice smith/.local/bin/myco',
      'daemon',
      'run',
    ]);
  });

  test('a spaced argument is preserved as one element', () => {
    const plist = renderLaunchdPlist(
      specWith({ args: ['daemon', '--root', '/opt/My Groves'] }),
    );
    const argv = programArguments(plist);
    expect(argv).toEqual([
      '/Users/alice/.local/bin/myco',
      'daemon',
      '--root',
      '/opt/My Groves',
    ]);
  });

  test('XML special characters in a path are escaped', () => {
    const plist = renderLaunchdPlist(
      specWith({ executable: '/Users/a&b <c>/myco' }),
    );
    // Raw value would break the XML; the rendered plist must escape it.
    expect(plist).toContain('<string>/Users/a&amp;b &lt;c&gt;/myco</string>');
    expect(plist).not.toContain('<string>/Users/a&b <c>/myco</string>');
  });
});
