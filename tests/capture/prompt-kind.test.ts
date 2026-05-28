import { describe, expect, it } from 'bun:test';
import {
  classifyNextPromptKind,
  classifyNextPromptOrigin,
  extractUserPromptKinds,
  extractUserPromptRecords,
} from '@myco/capture/prompt-kind.js';

// Regression: Claude Code writes real user prompts with `message.content` as a
// plain string, and tool_result entries with content as an array. The walker
// must handle both without crashing — earlier revisions called `.find` on the
// string and threw "content?.find is not a function", which silently killed
// every Stop-time reconcile pass.

describe('walkClaudeCode content shape handling', () => {
  const userPromptStringContent = (promptId: string, text: string) => ({
    type: 'user',
    promptId,
    message: { role: 'user', content: text },
  });

  const userPromptArrayContent = (promptId: string, text: string) => ({
    type: 'user',
    promptId,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

  const toolResultArrayContent = (promptId: string) => ({
    type: 'user',
    promptId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
    },
  });

  const assistantEndTurn = () => ({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
  });

  it('classifies a string-content user prompt as initial', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', 'Hello'),
    ]);
    expect(kinds).toEqual(['initial']);
  });

  it('classifies an array-content user prompt as initial', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptArrayContent('p1', 'Hello'),
    ]);
    expect(kinds).toEqual(['initial']);
  });

  it('handles mixed string + array content user prompts across a session', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', 'First'),
      assistantEndTurn(),
      userPromptArrayContent('p2', 'Second'),
    ]);
    expect(kinds).toEqual(['initial', 'initial']);
  });

  it('skips tool_result entries without throwing', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', 'Real prompt'),
      toolResultArrayContent('p1'), // duplicate promptId — already-seen
      toolResultArrayContent('p2'), // array content, no text block → skipped
    ]);
    expect(kinds).toEqual(['initial']);
  });

  it('classifies a mid-turn steering prompt when prior turn has not ended', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', 'First'),
      // No assistant end_turn — user sends a second prompt mid-turn.
      userPromptStringContent('p2', 'Steering'),
    ]);
    expect(kinds).toEqual(['initial', 'steering']);
  });

  it('detects the interrupt marker on string-content prompts', () => {
    const kinds = extractUserPromptKinds('claude-code', [
      userPromptStringContent('p1', '[Request interrupted by user for tool use]'),
    ]);
    expect(kinds).toEqual(['interrupt']);
  });

  it('does not throw on malformed events', () => {
    // A whole bag of misshapen events the walker should tolerate without
    // crashing. Any crash here cascades into a silently-killed reconcile.
    const events = [
      { type: 'user' /* no promptId */, message: { content: 'x' } },
      { type: 'user', promptId: 'p1' /* no message */ },
      { type: 'user', promptId: 'p2', message: {} /* no content */ },
      { type: 'user', promptId: 'p3', message: { content: 42 } as never },
      { type: 'assistant' /* no message */ },
    ];
    expect(() => extractUserPromptKinds('claude-code', events)).not.toThrow();
  });
});

describe('walkClaudeCode slash-command dispatch drop rule', () => {
  // When the user runs `/name args`, Claude Code logs two user entries
  // sharing one promptId: the XML-wrapped dispatch envelope and the
  // expanded command body. UserPromptSubmit already captured `/name args`
  // via the hook path, so both transcript entries are redundant and — if
  // left alone — cause reconcileBatchKinds to insert a phantom second
  // batch because the XML prefix doesn't match the hook-stored prefix.
  //
  // The manifest carries a `prompt_starts_with: "<command-message>"` drop
  // rule. Paired with `dedupeBy: promptId`, dropping the wrapper also
  // suppresses the expanded body.
  it('drops both transcript entries for a slash-command dispatch', () => {
    const events = [
      {
        type: 'user',
        promptId: 'p1',
        message: {
          role: 'user',
          content:
            '<command-message>simplify</command-message>\n'
            + '<command-name>/simplify</command-name>\n'
            + '<command-args>review the diff</command-args>',
        },
      },
      {
        type: 'user',
        promptId: 'p1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '# Simplify: Code Review and Cleanup\n...' }],
        },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual([]);
  });

  it('leaves a plain user prompt untouched when no dispatch envelope is present', () => {
    const events = [
      {
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: 'please review the diff' },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual(['initial']);
  });

  it('drops a built-in command dispatch whose content starts with <command-name>', () => {
    // /exit, /compact, /plugin, /mcp, /clear, /reload-plugins, /extra-usage
    // all land as user-type transcript entries starting with <command-name>.
    // They do not fire UserPromptSubmit and must not appear as captured prompts.
    const events = [
      {
        type: 'user',
        promptId: 'exit-1',
        message: {
          role: 'user',
          content:
            '<command-name>/exit</command-name>\n'
            + '<command-message>exit</command-message>\n'
            + '<command-args></command-args>',
        },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual([]);
  });

  it('suppresses the /compact caveat, dispatch, and summary as one envelope group', () => {
    // A real /compact invocation emits three user-type entries that share one
    // promptId: the isMeta=true caveat, the <command-name>/compact dispatch,
    // and the synthesized "This session is being continued..." summary.
    // The caveat is filtered by the isMeta shape match; the dispatch is
    // dropped by the <command-name> rule; the summary is suppressed via
    // dedupeBy: promptId. Net: zero records for the whole group.
    const events = [
      {
        type: 'user',
        promptId: 'compact-1',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' },
      },
      {
        type: 'user',
        promptId: 'compact-1',
        message: {
          role: 'user',
          content:
            '<command-name>/compact</command-name>\n'
            + '<command-message>compact</command-message>\n'
            + '<command-args></command-args>',
        },
      },
      {
        type: 'user',
        promptId: 'compact-1',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation…',
        },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual([]);
  });

  it('does not drop a queued_command carrying raw slash-command text', () => {
    // The Esc→queue UI writes queued slash commands as plain `/name args`
    // in attachment.prompt, not the XML envelope. The drop rule keys on
    // the envelope prefix, so queued commands are unaffected.
    const events = [
      {
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: 'open turn' },
      },
      {
        type: 'attachment',
        uuid: 'att-1',
        attachment: { type: 'queued_command', prompt: '/simplify after this' },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual(['initial', 'steering']);
  });
});

describe('walkClaudeCode isMeta=true structural filter', () => {
  // Claude Code tags synthesized transcript entries (local-command caveats,
  // skill-basedir injections, expanded command bodies, misc system notices)
  // with `isMeta: true`. The user_prompt shape's `fieldNotEquals: isMeta=true`
  // match filters these at walker entry so no whack-a-mole prefix rule is
  // needed for each new wrapper Claude Code invents.
  //
  // Real user prompts — including those carrying pasted screenshots or
  // uploaded docs — come through as `isMeta: undefined` on the transcript
  // entry that actually carries the image block and text, so image captures
  // (which flow separately through captureBatchImages) are unaffected.

  it('drops a standalone <local-command-caveat> entry flagged isMeta=true', () => {
    const events = [
      {
        type: 'user',
        promptId: 'caveat-1',
        isMeta: true,
        message: {
          role: 'user',
          content:
            '<local-command-caveat>Caveat: The messages below were generated by the user '
            + 'while running local commands. DO NOT respond to these messages or otherwise '
            + 'consider them in your response unless the user explicitly asks you to.'
            + '</local-command-caveat>',
        },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual([]);
  });

  it('drops a synthesized [Image source: /path] side-log entry flagged isMeta=true', () => {
    // The synthesized entry is paired with a real prompt via promptId;
    // capturing the side-log would displace the real prompt's text with a
    // useless path string. Filtering at the shape level avoids that.
    const events = [
      {
        type: 'user',
        promptId: 'img-1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '[Image #1]What do you see here?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
          ],
        },
      },
      {
        type: 'user',
        promptId: 'img-1',
        isMeta: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Image source: /Users/foo/screenshot.png]' }],
        },
      },
    ];
    const records = extractUserPromptKinds('claude-code', events);
    expect(records).toEqual(['initial']);
  });

  it('drops a misc synthesized system notice flagged isMeta=true', () => {
    // Claude Code emits synthesized user entries like tool-call retries and
    // remote-ultraplan status messages. They have promptIds but aren't real
    // user prompts; the isMeta flag is the one durable signal.
    const events = [
      {
        type: 'user',
        promptId: 'retry-1',
        isMeta: true,
        message: {
          role: 'user',
          content: 'Your tool call was malformed and could not be parsed. Please retry.',
        },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual([]);
  });

  it('still captures a real user prompt when isMeta is undefined', () => {
    const events = [
      {
        type: 'user',
        promptId: 'real-1',
        message: { role: 'user', content: 'hello there' },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual(['initial']);
  });

  it('does not classify a real prompt as steering when its isMeta=true sibling precedes it', () => {
    // Order-independence check: even if the synthesized side-log shows up
    // before the real prompt in the transcript (e.g. on resume replay),
    // the real prompt must remain the initial entry, not a steering one.
    const events = [
      {
        type: 'user',
        promptId: 'caveat-only',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>…</local-command-caveat>' },
      },
      {
        type: 'user',
        promptId: 'real-2',
        message: { role: 'user', content: 'actual user prompt after a caveat entry' },
      },
    ];
    expect(extractUserPromptKinds('claude-code', events)).toEqual(['initial']);
  });
});

describe('walkClaudeCode queued_command shape (Phase 4)', () => {
  // Claude Code's Esc→queue UI writes mid-turn prompts as
  //   type:"attachment", attachment:{type:"queued_command", prompt:"..."}
  // and never emits a matching `type:"user"` event. Before the declarative
  // manifest extension, the walker never saw these and steering prompts
  // submitted via the queue UI were lost. The manifest now names the
  // queued_command shape so the walker classifies them by position like
  // any other user prompt.
  it('captures a queued_command attachment as a steering prompt mid-turn', () => {
    const events = [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: 'first regular prompt' } },
      // No assistant end_turn → turn still open when queued command arrives.
      {
        type: 'attachment',
        uuid: 'att-1',
        attachment: { type: 'queued_command', prompt: 'steering via queue UI' },
      },
    ];
    const kinds = extractUserPromptKinds('claude-code', events);
    expect(kinds).toEqual(['initial', 'steering']);
  });

  it('dedupes queued_command attachments by uuid', () => {
    const events = [
      {
        type: 'attachment',
        uuid: 'att-dup',
        attachment: { type: 'queued_command', prompt: 'only once' },
      },
      {
        type: 'attachment',
        uuid: 'att-dup',
        attachment: { type: 'queued_command', prompt: 'only once' },
      },
    ];
    const kinds = extractUserPromptKinds('claude-code', events);
    expect(kinds).toEqual(['initial']);
  });

  it('ignores unrelated attachments (images, files)', () => {
    const events = [
      {
        type: 'attachment',
        uuid: 'img-1',
        attachment: { type: 'image', path: '/tmp/x.png' },
      },
    ];
    const kinds = extractUserPromptKinds('claude-code', events);
    expect(kinds).toEqual([]);
  });
});

describe('walker applies manifest capture.rules (Codex system-injection case)', () => {
  // Codex sends AGENTS.md + Myco cortex injection as the first
  // response_item/message/user in every rollout. It's structurally
  // identical to a real user prompt, so the codex manifest has a
  // `capture.rules` drop rule keyed on the injection prefix — that rule
  // must fire at transcript-mining time, not just at live hook time,
  // otherwise reconcile inserts the injection as a "missing" initial
  // batch and displaces the real user prompt.
  it('drops Codex response_item events matching the AGENTS.md drop rule', () => {
    const events = [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/foo\n\n<INSTRUCTIONS>\n...' }],
        },
      },
      {
        type: 'turn_context',
        payload: { turn_id: 't1' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'what has changed in this branch?' }],
        },
      },
    ];
    const records = extractUserPromptKinds('codex', events);
    expect(records).toEqual(['initial']);
  });
});

describe('walker tags origin per capture rule (K3 classify action)', () => {
  // K1 quantified: 175+ rows in 30 days of dogfood usage were
  // <task-notification> / <subagent_notification> / <skill> envelopes
  // misclassified as user-typed. The classify action keeps the prompt
  // in the captured set but tags it with origin='system' or
  // 'agent_dispatch' so UI default filters can hide it.

  it('Claude Code: tags <task-notification> as origin=system', () => {
    const events = [
      {
        type: 'user',
        promptId: 'tnp1',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>tid-1</task-id>\n<status>completed</status>\n<result>ok</result>\n</task-notification>',
        },
      },
    ];
    const records = extractUserPromptRecords('claude-code', events);
    expect(records).toHaveLength(1);
    expect(records[0]?.origin).toBe('system');
    expect(records[0]?.kind).toBe('initial');
  });

  it('Claude Code: tags <skill> envelopes as origin=system', () => {
    const events = [
      {
        type: 'user',
        promptId: 'sp1',
        message: {
          role: 'user',
          content: '<skill>\n<name>ce:review</name>\n<path>/some/SKILL.md</path>\n...',
        },
      },
    ];
    const records = extractUserPromptRecords('claude-code', events);
    expect(records).toHaveLength(1);
    expect(records[0]?.origin).toBe('system');
  });

  it('Claude Code: real user prompts retain origin=human', () => {
    const events = [
      {
        type: 'user',
        promptId: 'real',
        message: { role: 'user', content: 'fix the bug in foo.ts' },
      },
    ];
    const records = extractUserPromptRecords('claude-code', events);
    expect(records).toHaveLength(1);
    expect(records[0]?.origin).toBe('human');
    expect(records[0]?.kind).toBe('initial');
  });

  it('Codex: tags <subagent_notification> as origin=agent_dispatch', () => {
    const events = [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<subagent_notification>\n{"agent_path":"x","status":{"completed":"ok"}}\n</subagent_notification>' }],
        },
      },
    ];
    const records = extractUserPromptRecords('codex', events, '/tmp/codex-rollout.jsonl');
    expect(records).toHaveLength(1);
    expect(records[0]?.origin).toBe('agent_dispatch');
  });

  it('Codex: tags <environment_context> as origin=system', () => {
    const events = [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>\n  <shell>zsh</shell>\n  <cwd>/tmp</cwd>\n</environment_context>' }],
        },
      },
    ];
    const records = extractUserPromptRecords('codex', events, '/tmp/codex-rollout.jsonl');
    expect(records).toHaveLength(1);
    expect(records[0]?.origin).toBe('system');
  });

  it('classifyNextPromptOrigin returns the rule-tagged origin', () => {
    expect(classifyNextPromptOrigin('claude-code', '<task-notification>foo')).toBe('system');
    expect(classifyNextPromptOrigin('claude-code', 'plain user typing')).toBe('human');
    expect(classifyNextPromptOrigin('codex', '<subagent_notification>x')).toBe('agent_dispatch');
    expect(classifyNextPromptOrigin(undefined, 'anything')).toBe('human');
  });

  // K1 follow-up: agent-team teammate messages, environment context, autonomous
  // loop self-prompts, local-command caveats, persisted-output reinjection, and
  // system-reminder envelopes were all entering prompt_batches as origin='human'
  // because the Claude Code manifest only declared rules for <task-notification>
  // and <skill>. The hardcoded SYSTEM_MESSAGE_PREFIXES shortcut covered only
  // <task-notification> and <system-reminder> and skipped them entirely, never
  // surfacing them in the UI. Vault audit (eee9f25b): 1182 <teammate-message>
  // batches across the vault, all human-origin.
  it('Claude Code: tags <teammate-message> as origin=agent_dispatch', () => {
    const events = [
      {
        type: 'user',
        promptId: 'tm1',
        message: {
          role: 'user',
          content:
            '<teammate-message teammate_id="init-cli" color="blue">\nTask #1 complete.\n</teammate-message>',
        },
      },
    ];
    const records = extractUserPromptRecords('claude-code', events);
    expect(records).toHaveLength(1);
    expect(records[0]?.origin).toBe('agent_dispatch');
  });

  it.each([
    ['<environment_context>', '<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>'],
    ['<<autonomous-loop-dynamic>>', '<<autonomous-loop-dynamic>>'],
    ['<local-command-caveat>', '<local-command-caveat>Caveat: ...'],
    ['<persisted-output>', '<persisted-output>\nresumed turn\n</persisted-output>'],
    ['<system-reminder>', '<system-reminder>\nThe task tools haven\'t been used recently.\n</system-reminder>'],
  ])('Claude Code: tags %s envelopes as origin=system', (_label, content) => {
    const events = [
      { type: 'user', promptId: `sys-${_label}`, message: { role: 'user', content } },
    ];
    const records = extractUserPromptRecords('claude-code', events);
    expect(records).toHaveLength(1);
    expect(records[0]?.origin).toBe('system');
  });

  // Smoke test surfaced 2026-05-28: in Claude Code v2.1.32+ agent-team sessions,
  // teammate-messages are injected into the lead's transcript as `type: user`
  // entries that share the LEAD's current-turn `promptId`. The generic
  // `user_prompt` shape uses `dedupeBy: promptId` and was collapsing every
  // teammate-message into the lead's prompt batch. Fix: a dedicated
  // `teammate_message` shape (listed first) discriminates on the `teamName`
  // field that only agent-team-routed entries carry, dedupes by `uuid` so each
  // discrete teammate dispatch becomes its own record. Without that shape,
  // current-version teammate-messages are silently lost from capture.
  it('Claude Code: emits a record for each teammate-message even when sharing promptId with the lead prompt', () => {
    const sharedPromptId = 'lead-turn-1';
    const events = [
      {
        type: 'user',
        promptId: sharedPromptId,
        uuid: 'uuid-lead-prompt',
        message: { role: 'user', content: 'lead asks something' },
      },
      {
        type: 'user',
        promptId: sharedPromptId,
        uuid: 'uuid-teammate-1',
        teamName: 'origin-smoke',
        message: {
          role: 'user',
          content: '<teammate-message teammate_id="echoer" color="blue">first reply</teammate-message>',
        },
      },
      {
        type: 'user',
        promptId: sharedPromptId,
        uuid: 'uuid-teammate-2',
        teamName: 'origin-smoke',
        message: {
          role: 'user',
          content: '<teammate-message teammate_id="echoer" color="blue">second reply</teammate-message>',
        },
      },
    ];
    const records = extractUserPromptRecords('claude-code', events);
    expect(records).toHaveLength(3);
    // First: the lead's actual prompt — origin='human'.
    expect(records[0]?.origin).toBe('human');
    expect(records[0]?.text).toBe('lead asks something');
    // Both teammate-messages survive the promptId-shared dedupe and get tagged.
    expect(records[1]?.origin).toBe('agent_dispatch');
    expect(records[1]?.text).toContain('first reply');
    expect(records[2]?.origin).toBe('agent_dispatch');
    expect(records[2]?.text).toContain('second reply');
  });
});

describe('classifyNextPromptKind — tail predictions', () => {
  it('returns initial on an empty tail', () => {
    expect(classifyNextPromptKind('claude-code', [], 'hello')).toBe('initial');
  });

  it('returns steering when the last walker state has an open turn', () => {
    const events = [
      {
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: 'open turn' },
      },
    ];
    expect(classifyNextPromptKind('claude-code', events, 'follow-up')).toBe('steering');
  });

  it('returns initial when the last assistant event ended the turn', () => {
    const events = [
      {
        type: 'user',
        promptId: 'p1',
        message: { role: 'user', content: 'done' },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
      },
    ];
    expect(classifyNextPromptKind('claude-code', events, 'next')).toBe('initial');
  });

  it('tags interrupt marker regardless of walker state', () => {
    expect(
      classifyNextPromptKind(
        'claude-code',
        [],
        '[Request interrupted by user for tool use] continue later',
      ),
    ).toBe('interrupt');
  });
});
