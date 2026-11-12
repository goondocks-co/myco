import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { cardSession, learningSettings } from '../clients/capture.ts';
import { captureSession, takeRun, report } from '../clients/runs.ts';
import { endRun, event, runTool } from '../clients/requests.ts';
import { publishedTurns } from '../clients/capture.ts';

/** A claimed learning run covers served cards and leaves later capture for the next claim. */
export const extractionCoverage: ParityScenario = {
  name: 'extraction coverage: learning completions cover served material and leave late material for the next run',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    await learningSettings(target);
    const session = 'coverage-session';
    await captureSession(target, session, 'Material to extract', { ended: true, at: Date.now() - 3_600_000 });
    await cardSession(target, session, 'First material to extract');
    const first = await takeRun(target);
    expect(first.task).toBe('extract-curate');
    expect(await runTool(target, first, 'myco_run_learning', { op: 'complete' })).toMatchObject({ ok: false });
    const material = await runTool<any>(target, first, 'myco_run_learning', { op: 'material' });
    expect(material.cards).toHaveLength(1);
    const late = crypto.randomUUID();
    await event(target, session, 'prompt', { promptId: late, text: 'Late material to extract', origin: 'user' }, Date.now() - 3_500_000);
    await event(target, session, 'session.end', { endedAt: Date.now() });
    await publishedTurns(target, session, rows => rows.length === 2);
    expect(await runTool(target, first, 'myco_run_learning', { op: 'complete', handoff: 'Read the late material next.' })).toEqual({ completed: true, covered: 1 });
    expect(await runTool(target, first, 'myco_run_learning', { op: 'complete' })).toMatchObject({ ok: false });
    await report(target, first, 'extract', 'Covered the served card.');
    expect(await endRun(target, first)).toMatchObject({ ended: true });
    await cardSession(target, session, 'Late material to extract');
    const second = await takeRun(target);
    expect(second.task).toBe('extract-curate');
    const next = await runTool<any>(target, second, 'myco_run_learning', { op: 'material' });
    expect(next.cards).toHaveLength(1);
    expect(next.cards[0].card).toContain('Late material');
    expect(await runTool(target, second, 'myco_run_learning', { op: 'complete' })).toEqual({ completed: true, covered: 1 });
    await report(target, second, 'extract', 'Covered the late card.');
    expect(await endRun(target, second)).toMatchObject({ ended: true });
  },
};
