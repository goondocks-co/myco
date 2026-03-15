import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import path from 'node:path';

export interface ArtifactEvent {
  type: 'add' | 'change';
  path: string;
  absolutePath: string;
}

type ArtifactHandler = (event: ArtifactEvent) => void;

export class ArtifactWatcher {
  private watcher: FSWatcher | null = null;
  private handlers: ArtifactHandler[] = [];

  constructor(
    private projectRoot: string,
    private watchPaths: string[],
  ) {}

  onArtifact(handler: ArtifactHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    const absolutePaths = this.watchPaths.map((p) =>
      path.resolve(this.projectRoot, p),
    );

    this.watcher = watch(absolutePaths, {
      ignoreInitial: true,
      persistent: false,
      depth: 3,
    });

    this.watcher.on('add', (filePath) => this.emit('add', filePath));
    this.watcher.on('change', (filePath) => this.emit('change', filePath));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private emit(type: 'add' | 'change', absolutePath: string): void {
    const relativePath = path.relative(this.projectRoot, absolutePath);
    const event: ArtifactEvent = { type, path: relativePath, absolutePath };
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
