import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { readLocalSecrets, type LocalSecretName } from './local.js';

const SESSION_SECRET_BYTES = 32;

/** Read independently held credentials and validate wrapping material without recording secret values. */
export async function prepareRecoveryCredentials(source: string, secretsFile: string, newSignIn = false) {
  const sourceRoot = fs.realpathSync(source);
  const secretPath = fs.realpathSync(secretsFile);
  if (secretPath.startsWith(sourceRoot + path.sep)) throw new Error('recovery credentials must be supplied separately from the data artifact');
  const input = readLocalSecrets({ secretsFile: secretPath });
  const required = (name: LocalSecretName) => {
    const value = input[name];
    if (!value) throw new Error(`recovery requires independently supplied ${name}`);
    return value;
  };
  const secrets = { SECRET_WRAP_KEY: required('SECRET_WRAP_KEY'), ...(newSignIn
    ? { SESSION_SECRET: randomBytes(SESSION_SECRET_BYTES).toString('base64url') }
    : { SESSION_SECRET: required('SESSION_SECRET'), GITHUB_CLIENT_ID: required('GITHUB_CLIENT_ID'), GITHUB_CLIENT_SECRET: required('GITHUB_CLIENT_SECRET') }) };
  const key = wrappingKeyFromText(async () => secrets.SECRET_WRAP_KEY, 'recovery SECRET_WRAP_KEY');
  await key.material();
  return { secrets, key };
}
