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

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

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

  /**
   * Extract conversation turns from a session's transcript file.
   * Searches all configured transcript paths for a matching session ID.
   */
  extractConversation(sessionId: string, maxChars = 8000): ConversationTurn[] {
    for (const { baseDir } of this.paths) {
      const file = this.findSessionFile(baseDir, sessionId);
      if (!file) continue;

      try {
        return this.parseTranscript(file, maxChars);
      } catch {
        // Corrupted or unreadable — skip
      }
    }
    return [];
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

  private findSessionFile(baseDir: string, sessionId: string): string | null {
    if (!fs.existsSync(baseDir)) return null;

    // Transcript files are at <baseDir>/<project-hash>/<session-id>.jsonl
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

  private parseTranscript(filePath: string, maxChars: number): ConversationTurn[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const allTurns: ConversationTurn[] = [];

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === 'user') {
        const msg = entry.message as { content?: string | unknown[] } | undefined;
        // Only handle string content (skip tool_result arrays)
        if (typeof msg?.content !== 'string') continue;
        // Strip system/command tags that aren't real user content
        const cleaned = msg.content
          .replace(/<(?:command-[^>]*|local-command-[^>]*|task-notification|system-reminder|available-deferred-tools)>[\s\S]*?<\/(?:command-[^>]*|local-command-[^>]*|task-notification|system-reminder|available-deferred-tools)>/g, '')
          .replace(/<(?:command-name)[^>]*>[^<]*<\/command-name>/g, '')
          .trim();
        if (!cleaned || cleaned.length < 10) continue;
        allTurns.push({ role: 'user', content: cleaned.slice(0, 500) });
      } else if (entry.type === 'assistant') {
        const msg = entry.message as { content?: Array<{ type: string; text?: string }> } | undefined;
        if (!Array.isArray(msg?.content)) continue;
        // Extract text blocks only (skip thinking, tool_use)
        const textParts = msg!.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!.slice(0, 300));
        const text = textParts.join('\n').trim();
        if (!text) continue;
        allTurns.push({ role: 'assistant', content: text });
      }
    }

    // Keep the most recent turns that fit within the budget
    const result: ConversationTurn[] = [];
    let budget = maxChars;
    for (let i = allTurns.length - 1; i >= 0; i--) {
      if (allTurns[i].content.length > budget) break;
      result.unshift(allTurns[i]);
      budget -= allTurns[i].content.length;
    }

    return result;
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
