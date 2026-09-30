/**
 * The hosted Deployment's first administrator, from the operator's machine (#1500).
 *
 * The same setup the local target runs (`core/first-owner.ts`), over the Deployment's own database through the D1 API
 * and the operator's Cloudflare login (`d1OperatorStore`): no repository checkout, script or database command. It
 * records the admin member and mints the private link that member's first GitHub sign-in confirms, the rule both
 * targets share: bootstrap, then admin. The key is made here and only its digest reaches the Deployment.
 *
 * Nothing is written until the Deployment is recorded on this machine, answers GitHub sign-in, and runs this build's
 * schema: a link sign-in cannot confirm is a link nobody can use.
 */
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { setupFirstOwner } from '@myco-server-worker/core/first-owner.js';
import { assertWranglerReady, ensureCommandDir, operatorLogin, readDeploymentRecord, type CloudflareFetch } from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';
import { cloudflareOperation } from './cloudflare-operation.js';
import { d1OperatorStore } from './d1-operator-store.js';
import { signInConfigured } from './github-app.js';

export const CLOUDFLARE_SCHEMA_MISMATCH = `the Deployment must run this binary's schema (${SERVER_SCHEMA_VERSION}) before owner setup; run \`myco server update --target cloudflare\``;

export interface CloudflareOwnerOptions extends LifecycleOptions {
  /** Reaches the Deployment's sign-in route; the global fetch by default. */
  signInFetch?: typeof fetch;
  /** Reaches the Cloudflare API for the database; the global fetch by default. */
  fetch?: CloudflareFetch;
  now?: () => number;
}

/** Issues the hosted Deployment's first administrator link; a retry before the link is used replaces it. */
export const setupCloudflareOwner = cloudflareOperation(async (options: CloudflareOwnerOptions): Promise<{ memberId: string; url: string; expiresAt: number }> => {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('No Cloudflare Deployment record exists on this machine; `myco server create --target cloudflare --account-id <id>` provisions one');
  if (record.accountId !== options.accountId) throw new Error('this account does not match the Cloudflare Deployment record');
  if (record.url === undefined || record.url === '') throw new Error('the Cloudflare Deployment record names no URL; run `myco server update --target cloudflare` to record it');
  if (record.databaseId === undefined) throw new Error('the Cloudflare Deployment record names no database; run `myco server create --target cloudflare` again to finish provisioning');
  const origin = new URL(record.url).origin;
  const configDir = ensureCommandDir(options.mycoHome);
  await assertWranglerReady({ ...(options.runner === undefined ? {} : { runner: options.runner }), cwd: configDir, ...(options.report === undefined ? {} : { report: options.report }) });
  const signIn = await signInConfigured(origin, options.signInFetch);
  if (!signIn.ok) throw new Error(`${origin} does not sign in with GitHub yet (${signIn.reason}); run \`myco server github-app --target cloudflare --url ${origin}\` first`);
  const login = operatorLogin({ ...options, configDir });
  const db = d1OperatorStore({ accountId: record.accountId, databaseId: record.databaseId, login, fetch: options.fetch, report: options.report });
  const link = await setupFirstOwner(db, (options.now ?? Date.now)(), CLOUDFLARE_SCHEMA_MISMATCH);
  return { memberId: link.memberId, url: `${origin}/link#${link.key}`, expiresAt: link.expiresAt };
});
