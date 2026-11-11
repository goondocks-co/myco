import { expect, test } from 'bun:test';
import { redactSecrets } from '../../scripts/redact-secrets.mjs';

test('redacts a flag value, an Authorization header and a URL credential', () => {
  expect(redactSecrets('bun test --token abc123')).toBe('bun test --token <redacted>');
  expect(redactSecrets('Authorization: Bearer eyJhbGc')).toBe('Authorization: Bearer <redacted>');
  expect(redactSecrets('https://user:pw@host/x')).toBe('https://<redacted>@host/x');
});
