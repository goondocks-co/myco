export interface PlanSignal {
  source: 'hook' | 'artifact' | 'content' | 'transcript';
  confidence: 'high' | 'medium' | 'low';
  detail: string;
}

interface DetectionInput {
  hookEvents?: Array<Record<string, unknown>>;
  newFiles?: string[];
  sessionContent?: string;
}

const PLAN_DIRECTORIES = [
  'docs/superpowers/specs/',
  '.claude/plans/',
  '.cursor/plans/',
];

export class PlanDetector {
  detect(input: DetectionInput): PlanSignal[] {
    const signals: PlanSignal[] = [];

    if (input.hookEvents) {
      for (const event of input.hookEvents) {
        if (event.type === 'EnterPlanMode' || event.type === 'ExitPlanMode') {
          signals.push({
            source: 'hook',
            confidence: 'high',
            detail: `Plan mode ${event.type === 'EnterPlanMode' ? 'entered' : 'exited'}`,
          });
        }
      }
    }

    if (input.newFiles) {
      for (const file of input.newFiles) {
        if (PLAN_DIRECTORIES.some((dir) => file.startsWith(dir))) {
          signals.push({
            source: 'artifact',
            confidence: 'medium',
            detail: `New file in plan directory: ${file}`,
          });
        }
      }
    }

    return signals;
  }
}
