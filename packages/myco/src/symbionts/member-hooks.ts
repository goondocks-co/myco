/**
 * The member's hook block, derived from a symbiont's own hook template — the
 * one emitter behind both the `member-project` install scope (which writes it)
 * and `myco settings` (which prints it), so a provisioned laptop and a
 * provisioned sandbox can only differ in the credential source they declare.
 *
 * Two edits to the template: every command carries `--credential <source>`,
 * and the hook that never drains (PreToolUse) is not registered at all — the
 * member injects nothing before a tool call, so registering it would spend a
 * process per tool use to do nothing.
 */
import { CREDENTIAL_FLAG, NEVER_DRAINS_HOOK, hookNameInCommand, type CredentialSource } from '../member/constants.js';

/** Every hook command in a rendered or unrendered template, in document order. */
export function hookCommands(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(hookCommands);
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  if (typeof record.command === 'string') return [record.command];
  return Object.values(record).flatMap(hookCommands);
}

/** One hook entry or matcher group, or null when nothing in it survives for the member. */
function memberEntry(value: unknown, source: CredentialSource): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command === 'string') {
    if (hookNameInCommand(record.command) === NEVER_DRAINS_HOOK) return null;
    return { ...record, command: `${record.command} ${CREDENTIAL_FLAG} ${source}` };
  }
  if (Array.isArray(record.hooks)) {
    const hooks = record.hooks.map((hook) => memberEntry(hook, source)).filter((hook) => hook !== null);
    return hooks.length > 0 ? { ...record, hooks } : null;
  }
  return null;
}

/**
 * The member block for `template`. Throws when the template's nesting is one
 * this emitter does not understand: a silently dropped hook is capture the
 * member would never take, so the shape is asserted rather than assumed.
 */
export function memberHookTemplate(template: Record<string, unknown>, source: CredentialSource): Record<string, unknown> {
  const block: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(template)) {
    const groups = (Array.isArray(value) ? value : [value]).map((group) => memberEntry(group, source)).filter((group) => group !== null);
    if (groups.length > 0) block[event] = Array.isArray(value) ? groups : groups[0];
  }
  const expected = hookCommands(template).filter((command) => hookNameInCommand(command) !== NEVER_DRAINS_HOOK).length;
  const emitted = hookCommands(block).length;
  if (emitted !== expected) {
    throw new Error(`Refusing to emit member hooks: the template declares ${expected} member hook commands but this shape emits ${emitted}`);
  }
  return block;
}
