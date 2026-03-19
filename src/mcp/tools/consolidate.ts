import { VaultWriter } from '../../vault/writer.js';
import { indexNote } from '../../index/rebuild.js';
import type { MycoIndex } from '../../index/sqlite.js';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface ConsolidateInput {
  source_spore_ids: string[];
  consolidated_content: string;
  observation_type: string;
  tags?: string[];
}

interface ConsolidateResult {
  wisdom_id: string;
  wisdom_path: string;
  sources_archived: number;
}

export async function handleMycoConsolidate(
  vaultDir: string,
  index: MycoIndex,
  input: ConsolidateInput,
): Promise<ConsolidateResult> {
  const writer = new VaultWriter(vaultDir);
  const wisdomId = `${input.observation_type}-wisdom-${randomBytes(4).toString('hex')}`;

  // Build the wisdom note content with source links for Obsidian graph
  const sourceLinks = input.source_spore_ids.map((id) => `- [[${id}]]`).join('\n');
  const fullContent = `${input.consolidated_content}\n\n## Sources\n\nConsolidated from:\n${sourceLinks}`;

  // Create the consolidated wisdom note
  const wisdomPath = writer.writeSpore({
    id: wisdomId,
    observation_type: input.observation_type,
    tags: [...(input.tags ?? []), 'wisdom', 'consolidated'],
    content: fullContent,
  });

  // Add consolidated_from to the new note's frontmatter
  writer.updateNoteFrontmatter(wisdomPath, {
    consolidated_from: input.source_spore_ids,
  }, true);

  // Mark each source spore as superseded by the wisdom note
  let archived = 0;
  for (const sourceId of input.source_spore_ids) {
    const notes = index.queryByIds([sourceId]);
    if (notes.length > 0) {
      const notePath = notes[0].path;

      // Update frontmatter
      writer.updateNoteFrontmatter(notePath, {
        status: 'superseded',
        superseded_by: wisdomId,
      }, true);

      // Append supersession notice with wikilink to body
      const fullPath = path.join(vaultDir, notePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (!content.includes('Superseded by::')) {
        const notice = `\n\n> [!warning] Consolidated\n> This observation has been consolidated into a wisdom note.\n\nSuperseded by:: [[${wisdomId}]]`;
        fs.writeFileSync(fullPath, content.trimEnd() + notice + '\n', 'utf-8');
      }

      indexNote(index, vaultDir, notePath);
      archived++;
    }
  }

  // Index the new wisdom note
  indexNote(index, vaultDir, wisdomPath);

  return { wisdom_id: wisdomId, wisdom_path: wisdomPath, sources_archived: archived };
}
