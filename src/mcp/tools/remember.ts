import { VaultWriter } from '../../vault/writer.js';
import { indexNote } from '../../index/rebuild.js';
import type { MycoIndex } from '../../index/sqlite.js';
import { randomBytes } from 'node:crypto';

interface RememberInput {
  content: string;
  type: 'decision' | 'gotcha' | 'discovery' | 'cross-cutting';
  tags?: string[];
  related_plan?: string;
}

interface RememberResult {
  note_path: string;
  id: string;
}

export async function handleMycoRemember(
  vaultDir: string,
  index: MycoIndex,
  input: RememberInput,
): Promise<RememberResult> {
  const writer = new VaultWriter(vaultDir);
  const id = `${input.type}-${randomBytes(4).toString('hex')}`;

  const notePath = writer.writeMemory({
    id,
    observation_type: input.type,
    plan: input.related_plan ? `[[${input.related_plan}]]` : undefined,
    tags: input.tags,
    content: input.content,
  });

  // Update index so the new memory is immediately searchable
  indexNote(index, vaultDir, notePath);

  return { note_path: notePath, id };
}
