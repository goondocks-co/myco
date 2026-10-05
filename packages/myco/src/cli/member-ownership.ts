import { declaredCredentialSource, withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import { openDeploymentRequests, type MemberVerbDeps } from './deployment-reader.js';

export const OWNERSHIP_HELP = 'Usage: myco member ownership [--credential registry|env] [--server <url>] [--owner <member-id> | --transfer <member-id>] [--revision <reviewed-revision>]';
const PATH = '/members/ownership';

/** Recording initial ownership requires an explicitly selected member and reviewed revision. */
export async function runOwnership(args: readonly string[], deps: MemberVerbDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fail = (reason: string): false => { err(`myco member ownership: ${reason}`); return false; };
  let source;
  try { source = declaredCredentialSource(args) ?? 'registry'; }
  catch { return fail('pass --credential registry|env'); }
  const operands = withoutCredentialFlag(args);
  let ownerMemberId: string | undefined;
  let transferMemberId: string | undefined;
  let revision: string | undefined;
  let server: string | undefined;
  for (let i = 0; i < operands.length; i++) {
    const option = operands[i];
    const value = operands[++i];
    if (value === undefined || value.trim() === '' || value.startsWith('--')) return fail(OWNERSHIP_HELP);
    if (option === '--owner') ownerMemberId = value;
    else if (option === '--transfer') transferMemberId = value;
    else if (option === '--revision') revision = value;
    else if (option === '--server') server = value;
    else return fail(OWNERSHIP_HELP);
  }
  if (ownerMemberId !== undefined && transferMemberId !== undefined) return fail('choose either --owner or --transfer');
  if (((ownerMemberId ?? transferMemberId) === undefined) !== (revision === undefined)) return fail('the selected owner and --revision must be passed together; first review ownership without them');
  const opened = await openDeploymentRequests(source, deps, server);
  if (!opened.ok) return fail(opened.error.message);
  const reader = opened.value;
  const preview = await reader.get(PATH);
  if (!preview.ok) return fail(`the Deployment refused or failed the ownership preview (${preview.error.code})`);
  if (typeof preview.value.revision !== 'string' || (preview.value.ownerMemberId !== null && typeof preview.value.ownerMemberId !== 'string')) return fail('the Deployment returned an invalid ownership preview');
  out(JSON.stringify(preview.value, null, 2));
  if (ownerMemberId === undefined && transferMemberId === undefined) return true;
  if (preview.value.revision !== revision) return fail('ownership changed; review a new preview and pass its revision explicitly');
  if (transferMemberId !== undefined && preview.value.ownerMemberId === null) return fail('no owner is recorded; use --owner to record one first');
  if (ownerMemberId !== undefined && preview.value.ownerMemberId !== null) return fail('an owner is already recorded; use --transfer');
  const target = ownerMemberId ?? transferMemberId!;
  const candidates = preview.value.candidates;
  if (!Array.isArray(candidates) || !candidates.some((candidate) => typeof candidate === 'object' && candidate !== null && candidate.memberId === target && candidate.role === 'admin')) return fail('the selected member is not an eligible connected admin in this preview');
  const recorded = transferMemberId === undefined
    ? await reader.post(PATH, { ownerMemberId: target, revision })
    : await reader.post(`${PATH}/transfer`, { member_id: target, expected_revision: revision });
  if (!recorded.ok) return fail(`the Deployment refused or failed to ${transferMemberId === undefined ? 'record' : 'transfer'} ownership (${recorded.error.code})`);
  out(JSON.stringify(recorded.value, null, 2));
  return true;
}
