import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionIdentity, WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import { modelSelection, reportedModel } from '../accounting.js';
import type { Harness } from '../harnesses.js';
import { recordOf, stringOf, numberOf } from './stream.js';

/** Only files in the isolated run home are candidates for the run's own session. */
function* sessionFiles(dir: string): Iterable<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

/** A declared launch fallback is the exact model pinned into the run's configuration. */
export function codexLaunchIdentity(harness: Harness, config: Record<string, unknown>): ExecutionIdentity | null {
  if (harness.accounting.launchFallback !== 'resolved-config') return null;
  const model = stringOf(config.model);
  if (model === null) return null;
  const policy = harness.accounting.provider;
  const provider = stringOf(config.model_provider) ?? (policy.kind === 'session-config' ? policy.default : undefined);
  return modelSelection(reportedModel(harness, model, 'launch.config.model', null, provider), 'launched');
}

/** Session id and physical cwd must both match before a session can account for a run. */
export function codexSessionIdentity(harness: Harness, home: string, scratchDir: string, threadId: string | null, usage: WorkerUsage | null, launched: ExecutionIdentity | null = null): ExecutionIdentity | null {
  if (harness.accounting.reported !== 'codex-session' || threadId === null) return null;
  for (const file of sessionFiles(join(home, 'sessions'))) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    // Valid matching metadata admits the file; malformed records in an admitted file are errors.
    const meta = lines.flatMap((line) => {
      try {
        const record = recordOf(JSON.parse(line));
        return record?.type === 'session_meta' ? [record] : [];
      } catch { return []; }
    }).find((record) => recordOf(record.payload)?.id === threadId);
    const payload = recordOf(meta?.payload);
    if (payload?.id !== threadId || typeof payload.cwd !== 'string' || !existsSync(payload.cwd) || realpathSync(payload.cwd) !== realpathSync(scratchDir)) continue;
    const records = lines.map((line) => recordOf(JSON.parse(line)));
    const provider = stringOf(payload.model_provider) ?? (harness.accounting.launchFallback === 'resolved-config' && launched !== null && launched.status !== 'unknown' ? launched.primary.provider : undefined);
    const models = new Map<string, ReturnType<typeof reportedModel>>();
    let current: string | null = null;
    let previous = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
    let verified = true;
    for (const record of records) {
      const context = recordOf(record?.payload);
      if (record?.type === 'turn_context') {
        const model = stringOf(context?.model);
        if (model !== null) {
          const selected = reportedModel(harness, model, 'session.turn_context.model', null, stringOf(context?.model_provider) ?? provider);
          current = JSON.stringify([selected.provider, selected.model]);
          if (!models.has(current)) models.set(current, selected);
        }
      } else if (record?.type === 'event_msg' && context?.type === 'token_count' && current !== null) {
        const totals = recordOf(recordOf(context.info)?.total_token_usage);
        if (totals === null) continue;
        const inputTokens = numberOf(totals.input_tokens);
        const outputTokens = numberOf(totals.output_tokens);
        const cachedTokens = numberOf(totals.cached_input_tokens);
        const reasoningTokens = numberOf(totals.reasoning_output_tokens) ?? 0;
        if (inputTokens === null || outputTokens === null || cachedTokens === null) { verified = false; continue; }
        const next = { inputTokens, outputTokens, cachedTokens, reasoningTokens };
        const row = models.get(current)!;
        const old = row.usage;
        const delta = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, value - previous[key as keyof typeof previous]]));
        if (Object.values(delta).some((n) => n < 0 || !Number.isSafeInteger(n))) { verified = false; continue; }
        row.usage = {
          inputTokens: (old?.inputTokens ?? 0) + delta.inputTokens!, outputTokens: (old?.outputTokens ?? 0) + delta.outputTokens!,
          cachedTokens: (old?.cachedTokens ?? 0) + delta.cachedTokens!, reasoningTokens: (old?.reasoningTokens ?? 0) + delta.reasoningTokens!, costUsd: null,
        };
        previous = next;
      }
    }
    if (models.size === 0) continue;
    const all = [...models.values()];
    const primary = current === null ? all.at(-1)! : models.get(current)!;
    if (all.length === 1) primary.usage = usage;
    else if (!verified || usage?.inputTokens !== previous.inputTokens || usage.outputTokens !== previous.outputTokens || usage.cachedTokens !== previous.cachedTokens) {
      for (const model of all) if (model.usage !== null) model.usage.tokenScope = 'unverified';
    }
    return { status: 'reported', source: primary.source, primary: { model: primary.model, ...(primary.provider === undefined ? {} : { provider: primary.provider }) }, models: all };
  }
  return null;
}
