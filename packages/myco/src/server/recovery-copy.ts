import { withPrivateRecoveryCopy, type PrivateRecoveryCopy } from '@myco-server-worker/platform/bun/private-recovery-copy.js';
import { fingerprintFile } from './recovery-bundle.js';

/** The recovery owner verifies a fresh private copy before granting migration authority. */
export async function withRecoveryDatabaseCopy<T>(source: string, expected: Awaited<ReturnType<typeof fingerprintFile>>, use: (copy: PrivateRecoveryCopy) => Promise<T>): Promise<T> {
  return withPrivateRecoveryCopy(source, async file => {
    const actual = await fingerprintFile(file);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error('source recovery database changed during copy');
  }, use);
}
