import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HARNESSES } from '@myco/runner/harnesses.js';
import { runWorker } from '@myco/runner/loop.js';
import { withRunMcp, listingOnly } from './run-mcp-fetch.ts';

const MYCO_CALL = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'accounting_myco', name: 'mcp__myco__myco_run', input: { op: 'report' } }] } };

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const model = 'gpt-5.4-mini';
const PROFILE_MODELS: Readonly<Record<string, string>> = {
  'claude-code': 'sonnet', codex: 'configured-model', opencode: 'openai/gpt-5.4-mini',
};

export async function fixtureRun(harness: (typeof HARNESSES)[number], outcome: string, end: (body: Record<string, unknown>) => Promise<Response> = async () => Response.json({ persisted: true, ended: true }), options: { stream?: Record<string, unknown>[]; features?: string | null; credentialEnv?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'myco-accounting-'));
  const path = process.env.PATH;
  const home = process.env.HOME;
  try {
    process.env.HOME = root;
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"fixture"}');
    writeFileSync(join(root, '.codex', 'config.toml'), outcome === 'unknown' ? '' : 'model = "configured-model"\nmodel_provider = "openai"\n');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fixture"}}');
    mkdirSync(join(root, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(root, '.local', 'share', 'opencode', 'auth.json'), '{"openai":{"type":"oauth","refresh":"fixture"}}');
    let script: string;
    if (harness.id === 'claude-code') {
      const lines: Record<string, unknown>[] = [{ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 'fixture' }];
      if (outcome === 'failed_call') lines.push({ type: 'system', subtype: 'permission_denied', tool_name: 'Read' });
      if (outcome !== 'no_result') lines.push({ type: 'result', stop_reason: 'end_turn', ...(outcome === 'no_usage' ? {} : { usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) });
      if (outcome === 'unknown') for (const line of lines) delete line.model;
      script = [MYCO_CALL, ...(options.stream ?? lines)].map((line) => `printf '%s\\n' ${quote(JSON.stringify(line))}`).join('\n');
    } else if (harness.id === 'codex') {
      const records: Record<string, unknown>[] = [
        { type: 'session_meta', payload: { id: outcome === 'foreign_session' ? 'foreign-thread' : 'fixture-thread', cwd: '$PWD', model_provider: 'openai' } },
        { type: 'turn_context', payload: { model: outcome === 'spaced' ? ' gpt-x ' : outcome === 'oversized' ? 'x'.repeat(257) : model, cwd: '$PWD' } },
      ];
      if (outcome === 'many_models') for (let n = 0; n < 65; n++) records.push({ type: 'turn_context', payload: { model: 'model-' + n, cwd: '$PWD' } });
      if (outcome === 'multi_model') records.push(
        { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 } } } },
        { type: 'turn_context', payload: { model: 'gpt-5.4-nano', cwd: '$PWD' } },
        { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, output_tokens: 40, cached_input_tokens: 80 } } } },
      );
      if (outcome === 'unknown' || outcome === 'launched') records.length = 0;
      script = `mkdir -p "$CODEX_HOME/sessions/2026/10/01"\n` + records.map((row) => `printf '%s\\n' ${quote(JSON.stringify(row)).replaceAll('$PWD', "'\"$PWD\"'")} >> "$CODEX_HOME/sessions/2026/10/01/run.jsonl"`).join('\n') + '\n';
      if (outcome === 'truncated') script += `printf '%s' '{\"type\":' >> \"$CODEX_HOME/sessions/2026/10/01/run.jsonl\"\n`;
      if (outcome === 'foreign_noise') {
        script += `printf '%s\\n' '{broken' > "$CODEX_HOME/sessions/2026/10/01/aaa.jsonl"\n`;
        script += `printf '%s\\n' ${quote(JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-thread', cwd: join(root, 'absent') } }))} > "$CODEX_HOME/sessions/2026/10/01/aab.jsonl"\n`;
      }
      script += `printf '%s\\n' '{"type":"thread.started","thread_id":"fixture-thread"}'\n`;
      script += `printf '%s\\n' '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"myco","tool":"myco_run","status":"completed"}}'\n`;
      if (outcome === 'failed_call') script += `printf '%s\\n' '{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"fixture","status":"failed"}}'\n`;
      if (outcome !== 'no_result') script += `printf '%s\\n' '{"type":"turn.completed"${outcome === 'no_usage' ? '' : outcome === 'multi_model' ? ',"usage":{"input_tokens":300,"output_tokens":40,"cached_input_tokens":80}' : ',"usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":40}'}}'\n`;
    } else {
      const updates: Record<string, unknown>[] = outcome === 'acp_replace_unused' ? [
        { sessionUpdate: 'current_model_update', currentModelId: 'openai/used-first' },
        { sessionUpdate: 'agent_message_chunk', content: { text: 'response' } },
        { sessionUpdate: 'current_model_update', currentModelId: 'openai/unused-middle' },
        { sessionUpdate: 'current_model_update', currentModelId: 'openai/used-last' },
      ] : outcome.startsWith('acp_usage_') ? [
        { sessionUpdate: 'usage_update', ...(outcome === 'acp_usage_spend' ? { cost: { currency: 'USD', amount: 0.2 } } : { used: 10 }) },
        { sessionUpdate: 'current_model_update', currentModelId: 'openai/gpt-5.4-nano' },
      ] : [];
      updates.push({ sessionUpdate: 'tool_call', toolCallId: 'accounting_myco', title: 'mcp__myco__myco_run', kind: 'other', status: 'completed', rawInput: { op: 'report' } });
      const notifications = updates.map((update) => `printf '%s\\n' ${quote(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update } }))};`).join(' ');
      script = `if [ "$1" = "status" ]; then exit 0; fi
while IFS= read -r line; do
  id=$(printf '%s\\n' "$line" | sed -n 's/.*"id":[ ]*\\([0-9][0-9]*\\).*/\\1/p')
  case "$line" in
    *'"session/new"'*) agent=$(printf '%s' "$OPENCODE_CONFIG_CONTENT" | sed -n 's/.*"default_agent":"\\([^" ]*\\)".*/\\1/p'); result='{"sessionId":"fixture",${outcome === 'unknown' ? '' : outcome === 'unoffered' ? '"configOptions":[{"id":"model","category":"model","currentValue":"opencode/big-pickle","options":[{"value":"opencode/big-pickle"}]}],' : outcome === 'no_effort' ? '"configOptions":[{"id":"model","category":"model","currentValue":"openai/gpt-5.4-mini","options":[{"value":"openai/gpt-5.4-mini"}]}],' : '"configOptions":[{"id":"model","category":"model","currentValue":"openai/gpt-5.4-mini","options":[{"value":"openai/gpt-5.4-mini"}]},{"id":"effort","category":"thought_level","currentValue":"medium","options":[{"value":"medium"}]}],'}"modes":{"currentModeId":"'"$agent"'"}}'  ;;
    *'"session/prompt"'*) ${notifications} ${outcome === 'no_result' ? 'exit 1;' : ''} ${outcome === 'failed_call' ? `printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture","update":{"sessionUpdate":"tool_call","toolCallId":"call","title":"Read","status":"failed"}}}';` : ''} result='${JSON.stringify({ stopReason: 'end_turn', ...(outcome === 'no_usage' || outcome === 'unknown' ? {} : { usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0 } }) })}' ;;
    *'"session/close"'*) exit 0 ;;
    *) result='{}' ;;
  esac
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$result"
done`;
    }
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, harness.binary), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${path ?? ''}`;
    let report: Record<string, unknown> | undefined;
    const features = [EXECUTION_PROFILE_FEATURE, ...(options.features === null ? [] : (options.features ?? 'turn,worker-accounting-v1').split(','))].join(',');
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      if (String(_url).endsWith('/members/status')) return Response.json({ persisted: true }, { headers: { 'x-myco-features': features } });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(_url).endsWith('/worker/end')) { report = body; return end(body); }
      return Response.json({ persisted: true, claimed: true, heartbeatMs: 30000, leaseMs: 60000,
        run: { projectId: 'proj_1', id: 'run_usage', attemptId: 'attempt', task: 'extract-curate', instruction: 'do it', harness: harness.id, runToken: 'fixture', credentialEnv: options.credentialEnv ?? {}, timeoutSeconds: 30,
          profile: { tier: 'default', model: PROFILE_MODELS[harness.id] ?? 'unsupported', effort: 'medium', sources: { tier: 'task', model: 'configured' } } } }, { headers: { 'x-myco-features': features } });
    }) as typeof fetch;
    await withRunMcp('https://fixture', (request) => listingOnly(request, ['myco_run']), () => runWorker({ serverUrl: 'https://fixture', token: 'fixture', lockDir: null, runRoot: join(root, 'runs'), only: [harness.id], once: true, pollIdleMs: 1, log: () => {}, fetchImpl, signal: AbortSignal.timeout(5000) }));
    return report;
  } finally {
    process.env.PATH = path;
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    rmSync(root, { recursive: true, force: true });
  }
}
