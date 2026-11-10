import type { RelationalStore } from '../../core/adapters.js';
import { first, read, rows } from '../index.js';

export interface SecretRow {
  name: string;
  ciphertext: string;
  iv: string;
  key_version: number;
  updated_at: number;
  updated_by: string;
}

const one = read<[name: string], SecretRow>({ name: 'settings.secret', sql:
  'SELECT name,ciphertext,iv,key_version,updated_at,updated_by FROM deployment_secrets WHERE name=?1' });

export const readSecret = (db: RelationalStore, name: string): Promise<SecretRow | null> => first(db, one.bind(name));

const every = read<[], SecretRow>({ name: 'settings.secrets', sql: 'SELECT name,ciphertext,iv,key_version,updated_at,updated_by FROM deployment_secrets ORDER BY name' });
export const listSecrets = (db: RelationalStore): Promise<readonly SecretRow[]> => rows(db, every.bind());
