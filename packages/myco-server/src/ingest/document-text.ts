import type { ContentStore } from '../core/adapters.js';
import { blobObjectKey } from '../core/blob-objects.js';
import { readVerifiedContentText } from '../core/registered-content.js';
import { contentRegistration } from '../db/storage/content-lifecycle.js';

/** Referenced document bodies and the inline fields they stand for. */
export const DOCUMENT_TEXT_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  prompt: { blob: 'text' }, response: { blob: 'text' }, plan: { blob: 'content' },
  'tool.use': { blob: 'input', outputBlob: 'output' }, 'tool.failure': { blob: 'input', outputBlob: 'output' },
};

/** Registered document text is decoded only from its verified immutable generation. */
export async function documentText(env: ContentStore, projectId: string, key: string): Promise<string> {
  const blob = await contentRegistration(env.db, projectId, key);
  if (blob === null) throw new Error('document_event_body_missing');
  return readVerifiedContentText(env, blobObjectKey(projectId, key, blob.generation), blob.size, key);
}
