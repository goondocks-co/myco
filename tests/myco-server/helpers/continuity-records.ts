export const continuityRecords: Record<string, Record<string, unknown>[]> = {
  'claude-code': [
    { type: 'user', promptId: '00000000-0000-7000-8000-000000000001', message: { content: 'start' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '<ultraplan># First</ultraplan>' }, { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '<ultraplan># Second</ultraplan>' }] } },
    { type: 'user', promptId: '00000000-0000-7000-8000-000000000002', message: { content: 'later' } },
  ],
  codex: [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'start' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<proposed_plan># First</proposed_plan>' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 't1', name: 'Read', arguments: '{"path":"a"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 't1', output: 'ok' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<proposed_plan># Second</proposed_plan>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'later' }] } },
  ],
  pi: [
    { type: 'message', message: { role: 'user', content: 'start' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }, { type: 'toolCall', id: 't1', name: 'Read', arguments: { path: 'a' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 't1', content: 'ok' } },
    { type: 'message', message: { role: 'assistant', content: 'second' } },
    { type: 'message', message: { role: 'user', content: 'later' } },
  ],
  cursor: [
    { role: 'user', message: { content: 'start' } },
    { role: 'assistant', message: { content: 'first' } },
    { role: 'assistant', message: { content: 'second' } },
    { type: 'turn_ended' },
    { role: 'user', message: { content: 'later' } },
  ],
};

for (const [index, agent] of ['cline', 'opencode'].entries()) continuityRecords[agent] = [
  { v: 1, type: 'prompt', promptId: `00000000-0000-7000-8000-${String(index * 10 + 1).padStart(12, '0')}`, text: 'start' },
  { v: 1, type: 'response', text: 'first' },
  { v: 1, type: 'tool', name: 'Read', input: { path: 'a' }, output: 'ok', failed: false },
  { v: 1, type: 'response', text: 'second' },
  { v: 1, type: 'prompt', promptId: `00000000-0000-7000-8000-${String(index * 10 + 2).padStart(12, '0')}`, text: 'later' },
];
