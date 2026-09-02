/**
 * The member's plan-file channel: which tool calls count as a plan write, how a
 * path is keyed, and what the capture and the Stop backstop send.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planKeyForPath, type EnvelopeContext } from '@myco/member/envelope.js';
import { isInPlanDirectory, normalizePlanPath, planBackstop, planFileCapture, planFilePath, planWritePath, readPlanFile, MAX_PLAN_FILE_BYTES } from '@myco/member/plan-files.js';
import { emptySessionState } from '@myco/member/session-state.js';
import { sha256Text } from '@myco/member/text.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-files-'));
const ctx = (): EnvelopeContext => ({ agent: 'claude-code', sessionId: 'sess_1', version: '2.0.0-test', stage: (bytes, mediaType) => ({ sha256: sha256Text(bytes.toString('utf-8')), mediaType, size: bytes.byteLength, path: '/dev/null' }) }) as unknown as EnvelopeContext;

describe('plan write classification', () => {
  it('matches a write tool into a manifest plan directory on a directory boundary, with a plan extension, under any runtime\'s casing', () => {
    expect(planWritePath('claude-code', 'Write', { file_path: '.claude/plans/a.md' }, root)).toBe(path.join(root, '.claude/plans/a.md'));
    expect(planWritePath('claude-code', 'Edit', { file_path: path.join(root, '.claude/plans/deep/b.md') }, root)).toBe(path.join(root, '.claude/plans/deep/b.md'));
    expect(planWritePath('claude-code', 'Write', { file_path: path.join(os.homedir(), '.claude/plans/home.md') }, root)).toBe(path.join(os.homedir(), '.claude/plans/home.md'));
    expect(planWritePath('opencode', 'write', { filePath: '.opencode/plans/c.md' }, root)).toBe(path.join(root, '.opencode/plans/c.md'));
    expect(planWritePath('claude-code', 'Write', { file_path: '.claude/plans-extra/a.md' }, root)).toBeNull();
    expect(planWritePath('claude-code', 'Write', { file_path: '.claude/plans/a.txt' }, root)).toBeNull();
    expect(planWritePath('claude-code', 'Read', { file_path: '.claude/plans/a.md' }, root)).toBeNull();
    expect(planWritePath('claude-code', 'Write', { file_path: 'src/a.md' }, root)).toBeNull();
    expect(planWritePath('claude-code', 'Write', {}, root)).toBeNull();
    expect(planWritePath('claude-code', undefined, { file_path: '.claude/plans/a.md' }, root)).toBeNull();
    expect(planWritePath('codex', 'Write', { file_path: '.claude/plans/a.md' }, root)).toBeNull();
    expect(isInPlanDirectory('/x/plans', ['/x/plans'], root)).toBe(true);
  });

  it('keys a path project-relative inside the root, home-relative under home, and absolute elsewhere, always with forward slashes', () => {
    expect(normalizePlanPath(root, path.join(root, '.claude/plans/a.md'))).toBe('.claude/plans/a.md');
    expect(normalizePlanPath(root, path.join(os.homedir(), '.claude/plans/h.md'))).toBe('~/.claude/plans/h.md');
    expect(normalizePlanPath(root, '/elsewhere/plans/e.md')).toBe('/elsewhere/plans/e.md');
    expect(planFilePath(root, '.claude/plans/a.md')).toBe(path.join(root, '.claude/plans/a.md'));
    expect(planFilePath(root, '~/.claude/plans/h.md')).toBe(path.join(os.homedir(), '.claude/plans/h.md'));
  });
});

describe('plan file capture', () => {
  const file = path.join(root, '.claude/plans/p.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  it('reads the file once per content, keys it by its normalized path, names the prompt, and carries no status', () => {
    fs.writeFileSync(file, '# The plan\n\n- [ ] one\n');
    const state = { ...emptySessionState(), promptId: 'prompt-1' };
    const first = planFileCapture(ctx(), state, 'proj_1', root, file);
    expect(first.events).toHaveLength(1);
    const payload = first.events[0]!.envelope.payload as Record<string, unknown>;
    expect([payload.planKey, payload.title, payload.originPath, payload.promptId, payload.status, payload.content]).toEqual([planKeyForPath('proj_1', '.claude/plans/p.md'), 'The plan', '.claude/plans/p.md', 'prompt-1', undefined, '# The plan\n\n- [ ] one\n']);
    first.record(state);
    expect(state.planPaths).toEqual({ '.claude/plans/p.md': { planKey: payload.planKey, hash: sha256Text('# The plan\n\n- [ ] one\n') } });
    expect(planFileCapture(ctx(), state, 'proj_1', root, file).events).toEqual([]);
    // New content under a captured path keeps the key and names no prompt: the plan belongs to the turn that produced it.
    fs.writeFileSync(file, '# The plan\n\n- [x] one\n');
    const again = planFileCapture(ctx(), { ...state, promptId: 'prompt-9' }, 'proj_1', root, file);
    const againPayload = again.events[0]!.envelope.payload as Record<string, unknown>;
    expect([againPayload.planKey, againPayload.promptId]).toEqual([payload.planKey, undefined]);
    expect(readPlanFile(path.join(root, 'missing.md'))).toBeNull();
    expect(readPlanFile(root)).toBeNull();
  });

  it('titles a plan without a heading after its file, and leaves a file past the bound alone', () => {
    const plain = path.join(root, '.claude/plans/no-heading.md');
    fs.writeFileSync(plain, 'just text');
    const payload = planFileCapture(ctx(), emptySessionState(), 'proj_1', root, plain).events[0]!.envelope.payload as Record<string, unknown>;
    expect(payload.title).toBe('no-heading');
    const huge = path.join(root, '.claude/plans/huge.md');
    fs.writeFileSync(huge, 'x'.repeat(MAX_PLAN_FILE_BYTES + 1));
    expect(planFileCapture(ctx(), emptySessionState(), 'proj_1', root, huge).events).toEqual([]);
  });

  it('re-sends a shipped file whose content changed, once, and nothing for one unchanged or gone', () => {
    fs.writeFileSync(file, '# The plan\n\n- [x] one\n');
    const key = planKeyForPath('proj_1', '.claude/plans/p.md');
    const state = { ...emptySessionState(), promptId: 'prompt-2', planPaths: { '.claude/plans/p.md': { planKey: key, hash: sha256Text('# The plan\n\n- [ ] one\n') }, '.claude/plans/gone.md': { planKey: 'k-gone', hash: 'h' } } };
    const backstop = planBackstop(ctx(), state, root);
    expect(backstop.events.map((e) => [(e.envelope.payload as { planKey: string }).planKey, (e.envelope.payload as { content: string }).content, (e.envelope.payload as { promptId?: string }).promptId])).toEqual([[key, '# The plan\n\n- [x] one\n', undefined]]);
    backstop.record(state);
    expect(state.planPaths['.claude/plans/p.md']).toEqual({ planKey: key, hash: sha256Text('# The plan\n\n- [x] one\n') });
    expect(planBackstop(ctx(), state, root).events).toEqual([]);
    // A budget with no room left sends nothing.
    fs.writeFileSync(file, '# The plan\n\n- [x] one\n- [x] two\n');
    const spent: NonNullable<Parameters<typeof planBackstop>[3]> = { symbiont: 'claude-code', hookName: 'stop', declaredTimeoutMs: 5_000, hookBudgetMs: 5_000, deadline: 5_000, drains: true, connectTimeoutMs: 1_000, requestTimeoutMs: 2_000 };
    expect(planBackstop(ctx(), state, root, spent, () => 10_000).events).toEqual([]);
  });
});
