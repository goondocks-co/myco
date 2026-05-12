import { describe, expect, test } from 'bun:test';
import { renderLaunchdPlist } from '../../packages/myco/src/service/launchd-plist';
import type { ServiceSpec } from '../../packages/myco/src/service/types';

const baseSpec: ServiceSpec = {
  label: 'co.goondocks.myco',
  variant: 'prod',
  executable: '/Users/test/.local/share/myco/bin/myco',
  args: ['daemon'],
  workingDir: '/Users/test/.myco',
  env: {
    MYCO_HOME: '/Users/test/.myco',
    MYCO_SERVICE_VARIANT: 'prod',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  },
  stdoutPath: '/Users/test/.myco/service/logs/daemon.out.log',
  stderrPath: '/Users/test/.myco/service/logs/daemon.err.log',
  runAtLoad: true,
  keepAlive: true,
  throttleSeconds: 10,
};

describe('renderLaunchdPlist', () => {
  test('contains required keys with correct values', () => {
    const plist = renderLaunchdPlist(baseSpec);
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>co.goondocks.myco</string>');
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain('<string>/Users/test/.local/share/myco/bin/myco</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>10</integer>');
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('<string>/Users/test/.myco/service/logs/daemon.out.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>MYCO_HOME</key>');
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<string>/Users/test/.myco</string>');
  });

  test('starts with XML prolog and DOCTYPE', () => {
    const plist = renderLaunchdPlist(baseSpec);
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC');
  });

  test('XML-escapes ampersands and angle brackets in env values', () => {
    const spec: ServiceSpec = {
      ...baseSpec,
      env: { ...baseSpec.env, EVIL: 'a&b<c>"d' },
    };
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;&quot;d</string>');
    expect(plist).not.toContain('a&b<c>"d');
  });

  test('omits KeepAlive when keepAlive=false', () => {
    const plist = renderLaunchdPlist({ ...baseSpec, keepAlive: false });
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });
});
