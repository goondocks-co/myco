import type { RawClaimPreview } from '@goondocks/myco-shared/raw-claims';
import { CREDENTIAL_FLAG, CREDENTIAL_SOURCES, type CredentialSource } from '../member/constants.js';
import { openDeploymentRequests, type MemberVerbDeps } from './deployment-reader.js';

export const RAW_CLAIMS_HELP = 'Usage: myco member raw-claims [--credential registry|env] [--server <url>] [--apply --revision <reviewed-revision>]';
const PATH = '/members/raw-claims';
const REFUSALS: Readonly<Record<string, string>> = {
  not_owner: 'only the recorded Deployment owner may claim raw data',
  backfill_pending: 'uploader checks are still running; wait for them to finish and review a new preview',
  revision_conflict: 'the raw data changed; review a new preview and pass its revision explicitly',
  unauthorized: 'the Deployment refused this credential; sign in again',
  route_missing: 'this Deployment does not support raw claims; update it',
};

function isPreview(value: Record<string, unknown>): value is Record<string, unknown> & RawClaimPreview {
  return typeof value.revision === 'string' && value.revision.length > 0 && typeof value.complete === 'boolean' && Array.isArray(value.projects);
}

/** Preview by default; applying requires the revision the owner explicitly reviewed. */
export async function runRawClaims(args: readonly string[], deps: MemberVerbDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fail = (reason: string): false => { err(`myco member raw-claims: ${reason}`); return false; };
  let source: CredentialSource = 'registry';
  let apply = false;
  let revision: string | undefined;
  let server: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--apply') apply = true;
    else if (arg === '--revision') {
      revision = args[++i];
      if (revision === undefined || revision.trim() === '' || revision.startsWith('--')) return fail('--revision needs the revision from the preview');
    } else if (arg === '--server') {
      server = args[++i];
      if (server === undefined || server.trim() === '' || server.startsWith('--')) return fail('--server needs a URL');
    } else if (arg === CREDENTIAL_FLAG || arg.startsWith(`${CREDENTIAL_FLAG}=`)) {
      const value = arg === CREDENTIAL_FLAG ? args[++i] : arg.slice(CREDENTIAL_FLAG.length + 1);
      if (!(CREDENTIAL_SOURCES as readonly (string | undefined)[]).includes(value)) return fail('pass --credential registry|env');
      source = value as CredentialSource;
    } else return fail(RAW_CLAIMS_HELP);
  }
  if (apply !== (revision !== undefined)) return fail('--apply and --revision must be passed together; first run this command without them to review the preview');
  const opened = await openDeploymentRequests(source, deps, server);
  if (!opened.ok) return fail(opened.error.message);
  const reader = opened.value;
  const preview = await reader.get(PATH);
  if (!preview.ok) return fail(REFUSALS[preview.error.code] ?? `the Deployment refused or failed the preview (${preview.error.code})`);
  if (!isPreview(preview.value)) return fail('the Deployment returned an invalid preview');
  out(JSON.stringify(preview.value, null, 2));
  if (!apply) return true;
  if (!preview.value.complete) return fail(REFUSALS.backfill_pending!);
  if (preview.value.revision !== revision) return fail(REFUSALS.revision_conflict!);
  const claimed = await reader.post(PATH, { revision });
  if (!claimed.ok) return fail(REFUSALS[claimed.error.code] ?? `the Deployment refused or failed the claim (${claimed.error.code})`);
  out(JSON.stringify(claimed.value, null, 2));
  return true;
}
