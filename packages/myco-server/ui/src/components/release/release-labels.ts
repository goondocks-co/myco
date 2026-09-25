/** Words for release states and check failures. Static labels over the stored vocabulary; nothing here is generated. */
export const RELEASE_STATE_LABEL: Record<string, string> = {
  released: 'Released',
  merged_unreleased: 'Merged, not released',
  not_on_release_line: 'Not on a release line',
  unknown: 'Release unknown',
  unreconciled: 'Not checked',
};

export const CHECK_FAILURE_LABEL: Record<string, string> = {
  credential_rejected: 'GitHub refused the credential',
  rate_limited: 'GitHub rate limit reached',
  budget_exhausted: 'lookup limit reached',
  timeout: 'GitHub did not answer in time',
  network: 'GitHub could not be reached',
  not_found: 'not found on GitHub',
  repository_not_found: 'repository not found on GitHub',
  repository_not_found_without_credential: 'repository not found; a private repository needs a credential',
  truncated: 'tag listing too long to read',
  unexpected_response: 'unexpected GitHub response',
};

/**
 * Whether lookups without a token can be relied on where this Deployment runs. GitHub limits an unauthenticated
 * lookup per network address, and a Cloudflare Worker's lookups leave from addresses other tenants share and have
 * already spent, so there a token is needed even for a public repository. It follows the target, not the repository.
 */
export const lookupTokenNeeded = (target: string | null | undefined) => target === 'cloudflare';

/** What a token-less rate-limited check needs next: a token lifts GitHub's limit, whatever the target. */
export const RATE_LIMIT_REMEDY = 'Add a read-only lookup token: GitHub allows far more lookups with one.';

export const releaseStateLabel = (state: string) => RELEASE_STATE_LABEL[state] ?? state;
export const checkFailureLabel = (failure: string | null) => (failure === null ? null : CHECK_FAILURE_LABEL[failure] ?? failure);
/** A ref as people name it: `refs/tags/myco/v2.0.3` is `myco/v2.0.3`. */
export const shortRef = (ref: string) => ref.replace(/^refs\/(tags|heads)\//, '');
