import { declaredCredentialSource, withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import { openDeploymentRequests, type MemberVerbDeps } from './deployment-reader.js';

export const ROLE_HELP = 'Usage: myco member role [--credential registry|env] [--server <url>] [--member <member-id> --role admin|member --revision <reviewed-role-revision>]';
const PATH = '/members/roles';

/** A role change names one person and the exact role revision reviewed first. */
export async function runRole(args: readonly string[], deps: MemberVerbDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fail = (reason: string): false => { err(`myco member role: ${reason}`); return false; };
  let source;
  try { source = declaredCredentialSource(args) ?? 'registry'; }
  catch { return fail('pass --credential registry|env'); }
  const operands = withoutCredentialFlag(args);
  let memberId: string | undefined;
  let role: 'admin' | 'member' | undefined;
  let revision: string | undefined;
  let server: string | undefined;
  for (let i = 0; i < operands.length; i++) {
    const option = operands[i];
    const value = operands[++i];
    if (value === undefined || value.trim() === '' || value.startsWith('--')) return fail(ROLE_HELP);
    if (option === '--member') memberId = value;
    else if (option === '--role' && (value === 'admin' || value === 'member')) role = value;
    else if (option === '--revision') revision = value;
    else if (option === '--server') server = value;
    else return fail(ROLE_HELP);
  }
  if ([memberId, role, revision].filter((part) => part !== undefined).length % 3 !== 0) return fail('pass --member, --role and --revision together; review roles first');
  const opened = await openDeploymentRequests(source, deps, server);
  if (!opened.ok) return fail(opened.error.message);
  const reader = opened.value;
  const preview = await reader.get(PATH);
  if (!preview.ok) return fail(`the Deployment refused or failed the role preview (${preview.error.code})`);
  if (!Array.isArray(preview.value.members)) return fail('the Deployment returned an invalid role preview');
  out(JSON.stringify(preview.value, null, 2));
  if (memberId === undefined || role === undefined || revision === undefined) return true;
  const target = preview.value.members.find((row) => typeof row === 'object' && row !== null && row.id === memberId);
  if (target === undefined || typeof target.roleRevision !== 'string' || (target.role !== 'admin' && target.role !== 'member')) return fail('the selected member is not in this role preview');
  if (target.roleRevision !== revision) return fail('the member role changed; review a new preview and pass its revision explicitly');
  if (target.role === role) return fail(`this member is already ${role}`);
  const changed = await reader.post(PATH, { member_id: memberId, role, expected_revision: revision });
  if (!changed.ok) return fail(`the Deployment refused or failed the role change (${changed.error.code})`);
  out(JSON.stringify(changed.value, null, 2));
  return true;
}
