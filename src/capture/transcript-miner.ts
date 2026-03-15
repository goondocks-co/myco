import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface TranscriptEntry {
  source: string;
  sessionId: string;
  content: string;
  timestamp: string;
}

interface TranscriptConfig {
  additionalPaths?: string[];
}

const DEFAULT_TRANSCRIPT_PATHS: Array<{ source: string; baseDir: string }> = [
  {
    source: 'claude-code',
    baseDir: path.join(os.homedir(), '.claude', 'projects'),
  },
];

export class TranscriptMiner {
  private paths: Array<{ source: string; baseDir: string }>;

  constructor(config?: TranscriptConfig) {
    this.paths = [...DEFAULT_TRANSCRIPT_PATHS];

    if (config?.additionalPaths) {
      for (const p of config.additionalPaths) {
        this.paths.push({ source: 'custom', baseDir: p });
      }
    }
  }

  async mineRecent(since: Date): Promise<TranscriptEntry[]> {
    const entries: TranscriptEntry[] = [];

    for (const { source, baseDir } of this.paths) {
      if (!fs.existsSync(baseDir)) continue;

      try {
        const files = this.findRecentFiles(baseDir, since);
        for (const file of files) {
          const content = fs.readFileSync(file, 'utf-8');
          entries.push({
            source,
            sessionId: path.basename(file, path.extname(file)),
            content,
            timestamp: fs.statSync(file).mtime.toISOString(),
          });
        }
      } catch {
        console.warn(`TranscriptMiner: Could not read ${baseDir}`);
      }
    }

    return entries;
  }

  private findRecentFiles(dir: string, since: Date): string[] {
    if (!fs.existsSync(dir)) return [];

    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findRecentFiles(fullPath, since));
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        if (stat.mtime >= since) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }
}
