import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { serviceLabel, SERVICE_LABEL_PROD } from '../../packages/myco/src/service/labels';
import { SERVICE_UNIT_DIR_ENV } from '../../packages/myco/src/service/paths';

const DEFAULT_HOME = path.join(os.homedir(), '.myco');
const OTHER_HOME = path.join(os.homedir(), '.myco-dev');

const originalEnv = process.env[SERVICE_UNIT_DIR_ENV];

beforeEach(() => { delete process.env[SERVICE_UNIT_DIR_ENV]; });
afterEach(() => {
  if (originalEnv === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
  else process.env[SERVICE_UNIT_DIR_ENV] = originalEnv;
});

describe('service labels', () => {
  test('the default home (~/.myco) label is exactly co.goondocks.myco', () => {
    expect(SERVICE_LABEL_PROD).toBe('co.goondocks.myco');
    expect(serviceLabel(DEFAULT_HOME)).toBe('co.goondocks.myco');
  });

  test('a non-default home gets a distinct, stable hash-suffixed label', () => {
    const label = serviceLabel(OTHER_HOME);
    expect(label).toMatch(/^co\.goondocks\.myco\.[0-9a-f]{8}$/);
    expect(label).not.toBe(SERVICE_LABEL_PROD);
    // Determinism: same home => same label across calls.
    expect(serviceLabel(OTHER_HOME)).toBe(label);
  });

  test('two distinct non-default homes produce distinct labels', () => {
    const a = serviceLabel(path.join(os.homedir(), '.myco-a'));
    const b = serviceLabel(path.join(os.homedir(), '.myco-b'));
    expect(a).not.toBe(b);
  });

  test('sandbox install gets a deterministic suffix on the default-home label', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-abc/LaunchAgents';
    const labelA = serviceLabel(DEFAULT_HOME);
    expect(labelA).toMatch(/^co\.goondocks\.myco\.sandbox-[0-9a-f]{8}$/);
    // Determinism: same sandbox dir => same label across calls.
    expect(serviceLabel(DEFAULT_HOME)).toBe(labelA);
  });

  test('the home suffix and the sandbox suffix stack for a non-default home', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-abc/LaunchAgents';
    const label = serviceLabel(OTHER_HOME);
    expect(label).toMatch(/^co\.goondocks\.myco\.[0-9a-f]{8}\.sandbox-[0-9a-f]{8}$/);
  });

  test('different sandbox dirs produce different label suffixes — two sandboxes cannot race for the same launchd label', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-aaa/LaunchAgents';
    const labelA = serviceLabel(DEFAULT_HOME);
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-bbb/LaunchAgents';
    const labelB = serviceLabel(DEFAULT_HOME);
    expect(labelA).not.toBe(labelB);
  });

  test('unsetting the sandbox env restores the canonical default-home label (no leaked suffix)', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox/LaunchAgents';
    expect(serviceLabel(DEFAULT_HOME)).not.toBe(SERVICE_LABEL_PROD);
    delete process.env[SERVICE_UNIT_DIR_ENV];
    expect(serviceLabel(DEFAULT_HOME)).toBe(SERVICE_LABEL_PROD);
  });
});
