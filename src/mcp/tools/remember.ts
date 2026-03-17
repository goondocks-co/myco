import { VaultWriter } from '../../vault/writer.js';
import { indexNote } from '../../index/rebuild.js';
import type { MycoIndex } from '../../index/sqlite.js';
import type { ObservationType } from '../../vault/types.js';
import { resolveSessionFromBuffer } from '../../capture/buffer.js';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

interface RememberInput {
  content: string;
  type: ObservationType;
  tags?: string[];
  session?: string;
  related_plan?: string;
}

interface RememberResult {
  note_path: string;
  id: string;
  session?: string;
}

export async function handleMycoRemember(
  vaultDir: string,
  index: MycoIndex,
  input: RememberInput,
): Promise<RememberResult> {
  const writer = new VaultWriter(vaultDir);
  const id = `${input.type}-${randomBytes(4).toString('hex')}`;
  const session = input.session ?? resolveSessionFromBuffer(path.join(vaultDir, 'buffer'));

  const notePath = writer.writeMemory({
    id,
    observation_type: input.type,
    session,
    plan: input.related_plan ?? undefined,
    tags: input.tags,
    content: input.content,
  });

  // Update index so the new memory is immediately searchable
  indexNote(index, vaultDir, notePath);

  return { note_path: notePath, id, session };
}
