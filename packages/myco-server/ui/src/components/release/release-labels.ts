/** Words for release states and check failures. Static labels over the stored vocabulary; nothing here is generated. */
export const RELEASE_STATE_LABEL: Record<string, string> = {
  released: 'Released',
  merged_unreleased: 'Merged, not released',
  not_on_release_line: 'Not on a release line',
  unknown: 'Release unknown',
  unreconciled: 'Not checked',
};

export const CHECK_FAILURE_LABEL: Record<string, string> = {
  credential_rejected: 'GitHub refused the App’s access',
  rate_limited: 'GitHub rate limit reached; it resets within the hour',
  budget_exhausted: 'lookup limit reached',
  timeout: 'GitHub did not answer in time',
  network: 'GitHub could not be reached',
  not_found: 'not found on GitHub',
  repository_not_found: 'repository not found on GitHub',
  truncated: 'tag listing too long to read',
  unexpected_response: 'unexpected GitHub response',
  repository_not_connected: 'no repository is connected; connect one under Repository',
  app_not_configured: 'GitHub repository access needs setup on this server',
  account_not_approved: 'the account that installed the App is not approved here',
  installation_unavailable: 'the App installation was removed or suspended in GitHub',
  repository_not_granted: 'the App installation no longer includes this repository',
  permissions_missing: 'the App installation has not granted read access',
  github_unavailable: 'GitHub did not answer as expected',
};

export const releaseStateLabel = (state: string) => RELEASE_STATE_LABEL[state] ?? state;
export const checkFailureLabel = (failure: string | null) => (failure === null ? null : CHECK_FAILURE_LABEL[failure] ?? failure);
/** A ref as people name it: `refs/tags/myco/v2.0.3` is `myco/v2.0.3`. */
export const shortRef = (ref: string) => ref.replace(/^refs\/(tags|heads)\//, '');
