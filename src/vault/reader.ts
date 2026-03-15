import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseNoteFrontmatter, type VaultNote } from './types.js';

const VAULT_SUBDIRS = ['sessions', 'plans', 'memories', 'artifacts', 'team'];

export class VaultReader {
  constructor(private vaultDir: string) {}

  readNote(relativePath: string): VaultNote {
    const fullPath = path.join(this.vaultDir, relativePath);
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const { data, content } = matter(raw);
    const frontmatter = parseNoteFrontmatter(data as Record<string, unknown>);
    return { path: relativePath, frontmatter, content: content.trim() };
  }

  listNotes(subdir: string): VaultNote[] {
    const dirPath = path.join(this.vaultDir, subdir);
    if (!fs.existsSync(dirPath)) return [];

    const files = this.walkMarkdownFiles(dirPath);
    return files.map((filePath) => {
      const relativePath = path.relative(this.vaultDir, filePath);
      return this.readNote(relativePath);
    });
  }

  readAllNotes(): VaultNote[] {
    return VAULT_SUBDIRS.flatMap((subdir) => this.listNotes(subdir));
  }

  walkMarkdownFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];

    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walkMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }

    return results;
  }
}
