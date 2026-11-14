import { expect } from 'bun:test';
import { putCapability } from '../clients/requests.ts';
import { owner, type RouteTarget } from './requests.ts';

/** The owner enables curation, lets it visit the knowledge, then pauses it with its discovery checkpoint retained. */
export async function seedCuration(target: RouteTarget): Promise<void> {
  expect((await putCapability(target, 'spore_curation', true)).status).toBe(200);
  expect((await owner(target, '/api/wake', { method: 'POST' })).status).toBe(200);
  expect((await putCapability(target, 'spore_curation', false)).status).toBe(200);
}
