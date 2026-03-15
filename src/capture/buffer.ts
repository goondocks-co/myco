import fs from 'node:fs';
import path from 'node:path';

interface BufferOptions {
  maxEvents?: number;
}

export class EventBuffer {
  private filePath: string;
  private maxEvents: number;
  private eventCount = 0;

  constructor(
    private bufferDir: string,
    private sessionId: string,
    options: BufferOptions = {},
  ) {
    this.filePath = path.join(bufferDir, `${sessionId}.jsonl`);
    this.maxEvents = options.maxEvents ?? 500;

    if (fs.existsSync(this.filePath)) {
      const content = fs.readFileSync(this.filePath, 'utf-8').trim();
      this.eventCount = content ? content.split('\n').length : 0;
    }
  }

  append(event: Record<string, unknown>): void {
    fs.mkdirSync(this.bufferDir, { recursive: true });

    const line = JSON.stringify({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });

    fs.appendFileSync(this.filePath, line + '\n');
    this.eventCount++;
  }

  readAll(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line));
  }

  count(): number {
    return this.eventCount;
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  delete(): void {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
    this.eventCount = 0;
  }

  isOverflow(): boolean {
    return this.eventCount > this.maxEvents;
  }

  getFilePath(): string {
    return this.filePath;
  }
}
