import { VaultWriter } from '../../vault/writer.js';
import { indexNote } from '../../index/rebuild.js';
import type { MycoIndex } from '../../index/sqlite.js';
import fs from 'node:fs';
import path from 'node:path';

interface SupersedeInput {
  old_spore_id: string;
  new_spore_id: string;
  reason?: string;
}

interface SupersedeResult {
  old_spore: string;
  new_spore: string;
  status: 'superseded' | 'not_found';
}

export async function handleMycoSupersede(
  vaultDir: string,
  index: MycoIndex,
  input: SupersedeInput,
): Promise<SupersedeResult> {
  const writer = new VaultWriter(vaultDir);

  // Find the old spore note in the index
  const oldNotes = index.queryByIds([input.old_spore_id]);
  if (oldNotes.length === 0) {
    return { old_spore: input.old_spore_id, new_spore: input.new_spore_id, status: 'not_found' };
  }

  const oldNote = oldNotes[0];

  // Mark the old spore as superseded in frontmatter
  writer.updateNoteFrontmatter(oldNote.path, {
    status: 'superseded',
    superseded_by: input.new_spore_id,
  }, true);

  // Append a supersession notice to the body with wikilink for Obsidian graph
  const fullPath = path.join(vaultDir, oldNote.path);
  const content = fs.readFileSync(fullPath, 'utf-8');
  if (!content.includes('Superseded by::')) {
    const notice = `\n\n> [!warning] Superseded\n> This observation has been superseded.\n\nSuperseded by:: [[${input.new_spore_id}]]`;
    const reasonLine = input.reason ? `\nReason:: ${input.reason}` : '';
    fs.writeFileSync(fullPath, content.trimEnd() + notice + reasonLine + '\n', 'utf-8');
  }

  // Re-index the updated note
  indexNote(index, vaultDir, oldNote.path);

  return { old_spore: input.old_spore_id, new_spore: input.new_spore_id, status: 'superseded' };
}
