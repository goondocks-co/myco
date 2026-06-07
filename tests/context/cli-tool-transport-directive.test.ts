import { test, expect } from 'bun:test';
import {
  composeCortexInstructionInjection,
  CLI_TOOL_TRANSPORT_DIRECTIVE,
} from '@myco/context/cortex-injection-context.js';
import { composeSessionStartContext } from '@myco/context/session-start-context.js';
import { MycoConfigSchema } from '@myco/config/schema.js';

test('cli transport prepends the CLI directive at session-start', () => {
  const out = composeCortexInstructionInjection('BODY', 'session-start', { cliToolTransport: true });
  expect(out).not.toBeNull();
  expect(out!.text.startsWith(CLI_TOOL_TRANSPORT_DIRECTIVE)).toBe(true);
  expect(out!.text).toContain('BODY');
  expect(CLI_TOOL_TRANSPORT_DIRECTIVE).toContain('myco tool call');
});

test('default (mcp) adds no directive', () => {
  const out = composeCortexInstructionInjection('BODY', 'session-start');
  expect(out!.text).toBe('BODY');
});

test('cli transport directive also applies at subagent-start', () => {
  const out = composeCortexInstructionInjection('BODY', 'subagent-start', { cliToolTransport: true });
  expect(out!.text).toContain(CLI_TOOL_TRANSPORT_DIRECTIVE);
  expect(out!.text).toContain('BODY');
});

test('composeSessionStartContext forwards cliToolTransport to the cortex frame', () => {
  const config = MycoConfigSchema.parse({ version: 3 });
  const composed = composeSessionStartContext(config, 'BODY', { kind: 'global' }, { cliToolTransport: true });
  const cortexPart = composed.parts.find((p) => p.kind === 'cortex');
  expect(cortexPart?.text).toContain(CLI_TOOL_TRANSPORT_DIRECTIVE);
  expect(cortexPart?.text).toContain('myco tool call');
  expect(cortexPart?.text).toContain('BODY');
});

test('composeSessionStartContext omits the directive for default (mcp) transport', () => {
  const config = MycoConfigSchema.parse({ version: 3 });
  const composed = composeSessionStartContext(config, 'BODY', { kind: 'global' });
  const cortexPart = composed.parts.find((p) => p.kind === 'cortex');
  expect(cortexPart?.text).toBe('BODY');
});
