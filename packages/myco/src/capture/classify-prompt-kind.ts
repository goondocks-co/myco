import fs from 'node:fs';
import { classifyNextPromptKind } from './prompt-kind.js';

export interface ClassifyInput {
  agent: string | undefined;
  transcriptPath: string | undefined;
  prompt: string;
}

function readTail(path: string, maxBytes = 64 * 1024): { text: string; partial: boolean } {
  try {
    const stat = fs.statSync(path);
    const fd = fs.openSync(path, 'r');
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return { text: buf.toString('utf8'), partial: start > 0 };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', partial: false };
  }
}

function parseJsonlTail(path: string): Array<Record<string, unknown>> {
  const { text, partial } = readTail(path);
  if (!text) return [];
  const lines = text.split('\n').filter((l) => l.trim());
  // Partial reads may have started mid-line — drop the head to be safe.
  const parsable = partial ? lines.slice(1) : lines;
  const out: Array<Record<string, unknown>> = [];
  for (const line of parsable) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function classifyPromptKind(input: ClassifyInput): string {
  const events = input.transcriptPath ? parseJsonlTail(input.transcriptPath) : [];
  return classifyNextPromptKind(input.agent, events, input.prompt);
}
