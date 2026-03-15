import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import path from 'node:path';
import { FILE_WATCH_STABILITY_MS } from '../constants.js';

export interface PlanEvent {
  source: 'tool' | 'hook' | 'filesystem' | 'transcript';
  filePath?: string;
  sessionId?: string;
  detail: string;
  timestamp: string;
}

interface WatcherConfig {
  projectRoot: string;
  watchPaths: string[];
  onPlan: (event: PlanEvent) => void;
}

export class PlanWatcher {
  private config: WatcherConfig;
  private fsWatcher: FSWatcher | null = null;
  private knownPlans: Set<string> = new Set();

  constructor(config: WatcherConfig) {
    this.config = config;
  }

  checkToolEvent(event: { tool_name: string; tool_input?: any; session_id?: string }): void {
    if (event.tool_name === 'EnterPlanMode' || event.tool_name === 'ExitPlanMode') {
      this.config.onPlan({
        source: 'hook',
        sessionId: event.session_id,
        detail: `Plan mode ${event.tool_name === 'EnterPlanMode' ? 'entered' : 'exited'}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (['Write', 'Edit', 'Read'].includes(event.tool_name) && event.tool_input) {
      const filePath = event.tool_input.file_path ?? event.tool_input.path;
      if (filePath && this.isInPlanDirectory(filePath)) {
        this.knownPlans.add(filePath);
        this.config.onPlan({
          source: 'tool',
          filePath,
          sessionId: event.session_id,
          detail: `${event.tool_name} on plan file: ${path.basename(filePath)}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  startFileWatcher(): void {
    const absPaths = this.config.watchPaths.map((p) =>
      path.resolve(this.config.projectRoot, p),
    );
    this.fsWatcher = watch(absPaths, {
      ignoreInitial: true,
      persistent: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: FILE_WATCH_STABILITY_MS },
    });
    this.fsWatcher.on('add', (fp) => this.onFileChange(fp, 'created'));
    this.fsWatcher.on('change', (fp) => this.onFileChange(fp, 'modified'));
  }

  stopFileWatcher(): void {
    this.fsWatcher?.close();
    this.fsWatcher = null;
  }

  private onFileChange(absolutePath: string, action: string): void {
    const rel = path.relative(this.config.projectRoot, absolutePath);
    this.knownPlans.add(absolutePath);
    this.config.onPlan({
      source: 'filesystem',
      filePath: absolutePath,
      detail: `Plan file ${action}: ${rel}`,
      timestamp: new Date().toISOString(),
    });
  }

  private isInPlanDirectory(filePath: string): boolean {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.config.projectRoot, filePath);
    return this.config.watchPaths.some((wp) =>
      abs.startsWith(path.resolve(this.config.projectRoot, wp)),
    );
  }
}
