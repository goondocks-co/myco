import { describe, expect, test } from 'bun:test';
import { serviceLabel, SERVICE_LABEL_PROD, SERVICE_LABEL_DEV } from '../../packages/myco/src/service/labels';

describe('service labels', () => {
  test('prod label is co.goondocks.myco', () => {
    expect(SERVICE_LABEL_PROD).toBe('co.goondocks.myco');
    expect(serviceLabel('prod')).toBe('co.goondocks.myco');
  });

  test('dev label is co.goondocks.myco-dev', () => {
    expect(SERVICE_LABEL_DEV).toBe('co.goondocks.myco-dev');
    expect(serviceLabel('dev')).toBe('co.goondocks.myco-dev');
  });
});
