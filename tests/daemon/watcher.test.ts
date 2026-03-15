import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PlanWatcher, type PlanEvent } from '@myco/daemon/watcher';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('PlanWatcher', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-watch-'));
    fs.mkdirSync(path.join(projectDir, '.claude', 'plans'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('detects plan from Write tool targeting plan directory', () => {
    const events: PlanEvent[] = [];
    const watcher = new PlanWatcher({
      projectRoot: projectDir, watchPaths: ['.claude/plans/'],
      onPlan: (e) => events.push(e),
    });

    watcher.checkToolEvent({
      tool_name: 'Write',
      tool_input: { file_path: path.join(projectDir, '.claude/plans/my-plan.md') },
    });

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('tool');
  });

  it('detects EnterPlanMode / ExitPlanMode', () => {
    const events: PlanEvent[] = [];
    const watcher = new PlanWatcher({
      projectRoot: projectDir, watchPaths: ['.claude/plans/'],
      onPlan: (e) => events.push(e),
    });

    watcher.checkToolEvent({ tool_name: 'EnterPlanMode' });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('hook');
  });

  it('ignores tools targeting non-plan directories', () => {
    const events: PlanEvent[] = [];
    const watcher = new PlanWatcher({
      projectRoot: projectDir, watchPaths: ['.claude/plans/'],
      onPlan: (e) => events.push(e),
    });

    watcher.checkToolEvent({
      tool_name: 'Write',
      tool_input: { file_path: path.join(projectDir, 'src/foo.ts') },
    });

    expect(events).toHaveLength(0);
  });
});
