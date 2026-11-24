import type { RelationalStore } from '../../core/adapters.js';
import { first, read, rows } from '../index.js';
import { probeIsDue } from './runner-secret-health.js';
import type { StoredKeyFailure } from '@goondocks/myco-shared/run-diagnostic';

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

type RunnerSecretRow = SecretRow & { failure: StoredKeyFailure | null; probeDue: number | null };
const runnerSecret = read<[slot: string, now: number], RunnerSecretRow>({ name: 'settings.runnerSecret', sql:
  `SELECT name,ciphertext,iv,key_version,updated_at,updated_by,runner_failure AS failure,
    (${probeIsDue('?2')}) AS probeDue FROM deployment_secrets WHERE name=?1` });
export const readRunnerSecret = (db: RelationalStore, slot: string, now: number) => first(db, runnerSecret.bind(slot, now));

const every = read<[], SecretRow>({ name: 'settings.secrets', sql: 'SELECT name,ciphertext,iv,key_version,updated_at,updated_by FROM deployment_secrets ORDER BY name' });
export const listSecrets = (db: RelationalStore): Promise<readonly SecretRow[]> => rows(db, every.bind());
