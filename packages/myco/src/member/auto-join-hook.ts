/**
 * What a hook does in a repository it holds no connection for (#1547): spool into the repository's pending spool, ask
 * for a join when one is due and kick the member helper's join bucket to make it, and say once per session why a
 * repository is not captured, and what is held of it. Nothing here dials the Deployment: the hook's budget is spent on
 * the harness alone, and the helper is started as every helper is (`kickHelper`), out of the harness's job where it can
 * leave it.
 */
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import {
  autoJoinDue, clearLeft, isLeft, JOIN_BUCKET, noticeOnce, notCapturedNotice, placeRepository, readAutoJoinState, recordSessionSeen, requestJoin, rootKeyFor,
  settingsMoved, silentRepository, sweepDone,
} from './auto-join.js';
import { kickHelper } from './helper.js';
import type { DetachedSpawn } from '../runtime/spawn-detached.js';
import type { CredentialRecord } from './credential.js';
import { defaultMembership } from './default-deployment.js';
import { machineAutoJoinLeaves } from './machine-settings.js';
import { pendingSpool, readHeldEnd } from './pending.js';
import type { MemberSpool } from './spool.js';

/** What a hook holds in a repository with no connection: the pending spool and the credential it is built under, and what to tell the person. */
export interface AutoJoinHold {
  /** The repository the hook is in. */
  repo: { root: string; rootKey: string };
  /** The pending spool, read and staged through, or null where the repository spools nothing: outside the folders, or past the cap. */
  spool: MemberSpool | null;
  /** The default Deployment's membership, as the record a pending run is built under. It names no project. */
  credential: CredentialRecord;
  notice: string | null;
}

/** Whether a hook's answer reaches the agent, so a notice in it is read: a session start that takes an injection, or a prompt. */
export function hookTakesNotice(hookName: string, agent: string): boolean {
  if (hookName === 'user-prompt-submit') return true;
  return hookName === 'session-start' && HOOK_CONFIG[agent]?.capabilities.sessionStartInjection === true;
}

/** A repository left with `myco member leave`: its hooks capture, hold and say nothing. */
export const LEFT_ALONE = 'left';

/**
 * The hold for a hook at `root`; {@link LEFT_ALONE} for a repository left with `myco member leave`; or null where
 * auto-join has no say: no default Deployment, or a repository the machine never captures. The notice reaches the
 * agent in the hook's answer, and nothing is written to stderr.
 */
export function autoJoinHold(opts: {
  root: string; hookName: string; agent: string; sessionId: string; mycoHome: string; now: number; env?: NodeJS.ProcessEnv; spawn?: DetachedSpawn;
}): AutoJoinHold | typeof LEFT_ALONE | null {
  const membership = defaultMembership(opts.mycoHome);
  if (membership === null) return null;
  const join = (): void => { kickHelper({ projectId: JOIN_BUCKET, mycoHome: opts.mycoHome, spawn: opts.spawn, now: () => opts.now }); };
  // Repositories met before auto-join existed are swept once, by the helper's join bucket.
  if (!sweepDone(opts.mycoHome)) join();
  if (silentRepository(opts.root, { mycoHome: opts.mycoHome, env: opts.env })) return null;
  const rootKey = rootKeyFor(opts.root, opts.mycoHome);
  const leaves = machineAutoJoinLeaves(membership.serverUrl, opts.mycoHome);
  const connectTo = Object.prototype.hasOwnProperty.call(leaves.connectRoots, rootKey) ? leaves.connectRoots[rootKey]! : null;
  // Left with `myco member leave`: nothing is captured, held or said, until the repository is connected again.
  if (isLeft(rootKey, opts.mycoHome)) {
    if (connectTo === null) return LEFT_ALONE;
    clearLeft(rootKey, opts.mycoHome);
  }
  recordSessionSeen(rootKey, opts.sessionId, opts.mycoHome);
  // The cached settings can be newer than the ones the last attempt read: a repository they place elsewhere (its
  // folder now captured, or connected from "Needs you") is tried again at once. Any other waits out its backoff.
  const placement = placeRepository({ root: opts.root, rootKey }, leaves);
  const state = readAutoJoinState(rootKey, opts.mycoHome);
  const moved = settingsMoved(state, placement, connectTo);
  if (moved || autoJoinDue(state, opts.now)) {
    requestJoin(opts.root, rootKey, opts.mycoHome, opts.now);
    join();
  }
  // Every repository that has not joined holds what its hooks capture, for the TTL or to the cap: connecting it, from
  // "Needs you" or with `myco member join`, delivers it.
  const spool = pendingSpool({ root: opts.root, rootKey }, { mycoHome: opts.mycoHome, now: opts.now });
  const text = state === null ? null : notCapturedNotice({ ...state, serverUrl: membership.serverUrl }, leaves.autoJoinRoots, readHeldEnd(rootKey, opts.mycoHome));
  const notice = text !== null && hookTakesNotice(opts.hookName, opts.agent) && noticeOnce(opts.sessionId, opts.mycoHome, opts.now) ? text : null;
  return {
    repo: { root: opts.root, rootKey },
    spool,
    credential: { serverUrl: membership.serverUrl, token: membership.token, tokenId: membership.tokenId, projectId: '', source: 'registry', root: opts.root },
    notice,
  };
}
