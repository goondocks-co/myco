import fs from 'node:fs';
import path from 'node:path';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { LOCAL_SECRET_NAMES, readLocalSecrets, type LocalSecretName } from './local.js';

/** Read independently held credentials and validate wrapping material without recording secret values. */
export async function readRecoveryCredentials(source: string, secretsFile: string) {
  const sourceRoot = fs.realpathSync(source);
  const secretPath = fs.realpathSync(secretsFile);
  if (secretPath.startsWith(sourceRoot + path.sep)) throw new Error('recovery credentials must be supplied separately from the data artifact');
  const input = readLocalSecrets({ secretsFile: secretPath });
  const secrets = {} as Record<LocalSecretName, string>;
  for (const name of LOCAL_SECRET_NAMES) {
    const value = input[name];
    if (!value) throw new Error(`recovery requires independently supplied ${name}`);
    secrets[name] = value;
  }
  const key = wrappingKeyFromText(async () => secrets.SECRET_WRAP_KEY, 'recovery SECRET_WRAP_KEY');
  await key.material();
  return { secrets, key };
}
