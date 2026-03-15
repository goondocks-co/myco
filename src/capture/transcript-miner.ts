import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

  /**
   * Get the most recent assistant text response from a session's transcript.
   * Scans from the end for efficiency — avoids parsing the entire file.
   */
  getLastAssistantResponse(sessionId: string): string | null {
    for (const { baseDir } of this.paths) {
      const file = this.findSessionFile(baseDir, sessionId);
      if (!file) continue;

      try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n').filter(Boolean);

        for (let i = lines.length - 1; i >= 0; i--) {
          let entry: Record<string, unknown>;
          try { entry = JSON.parse(lines[i]); } catch { continue; }

          if (entry.type !== 'assistant') continue;
          const msg = entry.message as { content?: Array<{ type: string; text?: string }> } | undefined;
          if (!Array.isArray(msg?.content)) continue;

          const textParts = msg!.content
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!);
          const text = textParts.join('\n').trim();
          if (text) return text;
        }
      } catch {
        // Corrupted or unreadable
      }
    }
    return null;
  }

  private findSessionFile(baseDir: string, sessionId: string): string | null {
    if (!fs.existsSync(baseDir)) return null;

    try {
      const projects = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const candidate = path.join(baseDir, project.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // Permission or read error
    }
    return null;
  }
}
