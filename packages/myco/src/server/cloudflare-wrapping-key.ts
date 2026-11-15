import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WRAPPING_KEY_BYTES, wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { readLocalSecrets } from './local.js';
import { ensureCommandDir, peekCommandDir } from './cloudflare.js';
import { withCloudflareOperation } from './cloudflare-operation.js';

export const cloudflareWrappingKeyPath = (mycoHome?: string): string => path.join(peekCommandDir(mycoHome), 'secrets.env');

/** Read operator-held material using the native secrets-file grammar. */
export function readCloudflareWrappingKey(mycoHome?: string): string | undefined {
  return readLocalSecrets({ secretsFile: cloudflareWrappingKeyPath(mycoHome) }).SECRET_WRAP_KEY;
}

/** Retain wrapping material durably before it can be installed remotely. */
export function holdCloudflareWrappingKey(options: { mycoHome?: string; value?: string }): Promise<string> {
  return withCloudflareOperation(options.mycoHome, async () => {
    const value = options.value ?? readCloudflareWrappingKey(options.mycoHome) ?? randomBytes(WRAPPING_KEY_BYTES).toString('base64');
    await wrappingKeyFromText(async () => value, 'operator SECRET_WRAP_KEY').material();
    ensureCommandDir(options.mycoHome);
    atomicWriteFileSync(cloudflareWrappingKeyPath(options.mycoHome), `SECRET_WRAP_KEY=${value}\n`, { mode: 0o600, durable: true });
    return value;
  });
}

/** Local custody is observable; Secrets Store values cannot be read back. */
export function cloudflareWrappingKeyLine(mycoHome?: string): string {
  const file = cloudflareWrappingKeyPath(mycoHome);
  const present = fs.statSync(file, { throwIfNoEntry: false }) !== undefined && !!readCloudflareWrappingKey(mycoHome);
  return present
    ? `Wrapping key file held at ${file}; matching the Secrets Store cannot be verified. Restore with stored credentials needs this file.`
    : `Wrapping key file absent at ${file}; a restore will ask for stored credentials again (--new-credentials).`;
}
