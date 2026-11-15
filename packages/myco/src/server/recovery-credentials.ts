import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { wrappingKeyFromText, WRAPPING_KEY_BYTES } from '@myco-server-worker/platform/wrapping-key.js';
import { readLocalSecrets, type LocalSecretName } from './local.js';

const SESSION_SECRET_BYTES = 32;

/** Read independently held credentials and validate wrapping material without recording secret values. */
export async function prepareRecoveryCredentials(options: {
  source: string; secretsFile?: string; newSignIn?: boolean; fork?: boolean;
  newCredentials?: boolean; generatedWrapKey?: string;
}) {
  const { source, secretsFile, newSignIn, fork, newCredentials } = options;
  const sourceRoot = fs.realpathSync(source);
  const secretPath = secretsFile === undefined ? undefined : fs.realpathSync(secretsFile);
  if (secretPath?.startsWith(sourceRoot + path.sep)) throw new Error('recovery credentials must be supplied separately from the data artifact');
  const input = secretPath === undefined ? {} : readLocalSecrets({ secretsFile: secretPath });
  if (newCredentials && input.SECRET_WRAP_KEY) throw new Error('recovery refuses both --new-credentials and SECRET_WRAP_KEY; remove the key from --secrets-from or omit --new-credentials');
  const required = (name: LocalSecretName) => {
    const value = input[name];
    if (!value) throw new Error(`recovery requires independently supplied ${name}${name === 'SECRET_WRAP_KEY' ? '; supply --secrets-from <file>, or use --new-credentials to enter stored credentials again' : '; supply --secrets-from <file>, or use --new-signin'}`);
    return value;
  };
  const secrets = { SECRET_WRAP_KEY: newCredentials ? options.generatedWrapKey ?? randomBytes(WRAPPING_KEY_BYTES).toString('base64') : required('SECRET_WRAP_KEY'), ...(newSignIn
    ? { SESSION_SECRET: randomBytes(SESSION_SECRET_BYTES).toString('base64url') }
    : { SESSION_SECRET: fork ? randomBytes(SESSION_SECRET_BYTES).toString('base64url') : required('SESSION_SECRET'), GITHUB_CLIENT_ID: required('GITHUB_CLIENT_ID'), GITHUB_CLIENT_SECRET: required('GITHUB_CLIENT_SECRET') }) };
  const key = wrappingKeyFromText(async () => secrets.SECRET_WRAP_KEY, 'recovery SECRET_WRAP_KEY');
  await key.material();
  return { secrets, key };
}
