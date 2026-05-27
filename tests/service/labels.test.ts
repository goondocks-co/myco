import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { serviceLabel, SERVICE_LABEL_PROD, SERVICE_LABEL_DEV } from '../../packages/myco/src/service/labels';
import { SERVICE_UNIT_DIR_ENV } from '../../packages/myco/src/service/paths';

const originalEnv = process.env[SERVICE_UNIT_DIR_ENV];

beforeEach(() => { delete process.env[SERVICE_UNIT_DIR_ENV]; });
afterEach(() => {
  if (originalEnv === undefined) delete process.env[SERVICE_UNIT_DIR_ENV];
  else process.env[SERVICE_UNIT_DIR_ENV] = originalEnv;
});

describe('service labels', () => {
  test('prod label is co.goondocks.myco', () => {
    expect(SERVICE_LABEL_PROD).toBe('co.goondocks.myco');
    expect(serviceLabel('prod')).toBe('co.goondocks.myco');
  });

  test('dev label is co.goondocks.myco-dev', () => {
    expect(SERVICE_LABEL_DEV).toBe('co.goondocks.myco-dev');
    expect(serviceLabel('dev')).toBe('co.goondocks.myco-dev');
  });

  test('sandbox install gets a deterministic suffix on the prod label', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-abc/LaunchAgents';
    const labelA = serviceLabel('prod');
    expect(labelA).toMatch(/^co\.goondocks\.myco\.sandbox-[0-9a-f]{8}$/);
    // Determinism: same sandbox dir => same label across calls.
    expect(serviceLabel('prod')).toBe(labelA);
  });

  test('sandbox install gets a deterministic suffix on the dev label', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-abc/LaunchAgents';
    const labelA = serviceLabel('dev');
    expect(labelA).toMatch(/^co\.goondocks\.myco-dev\.sandbox-[0-9a-f]{8}$/);
  });

  test('different sandbox dirs produce different label suffixes — two sandboxes cannot race for the same launchd label', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-aaa/LaunchAgents';
    const labelA = serviceLabel('prod');
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox-bbb/LaunchAgents';
    const labelB = serviceLabel('prod');
    expect(labelA).not.toBe(labelB);
  });

  test('unsetting the sandbox env restores the canonical label (no leaked suffix)', () => {
    process.env[SERVICE_UNIT_DIR_ENV] = '/tmp/sandbox/LaunchAgents';
    expect(serviceLabel('prod')).not.toBe(SERVICE_LABEL_PROD);
    delete process.env[SERVICE_UNIT_DIR_ENV];
    expect(serviceLabel('prod')).toBe(SERVICE_LABEL_PROD);
  });
});
