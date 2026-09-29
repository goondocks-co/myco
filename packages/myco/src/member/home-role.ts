/**
 * Whether a Myco home is a 2.0 member home: it holds a Deployment membership,
 * or a cutover moved it from 1.4. A member home never runs the 1.4 local
 * daemon: nothing spawns it, it refuses to start, it installs no service,
 * and it never rewrites the agents' global config. Capture and tools reach
 * the Deployment through the member credential instead, so a 1.4 hook or
 * MCP entry left anywhere on the machine is inert.
 *
 * The one predicate every such path reads (`tests/meta/member-home-daemon-gate.test.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEMBER_DIRNAME } from './store.js';

/** Where a home keeps its Deployment memberships, and the record a cutover leaves. */
const DEPLOYMENTS_DIR = 'deployments';
export const CUTOVER_STATE_FILE = 'cutover.json';

export function isMemberHome(mycoHome: string): boolean {
  const member = path.join(mycoHome, MEMBER_DIRNAME);
  if (fs.existsSync(path.join(member, CUTOVER_STATE_FILE))) return true;
  try {
    return fs.readdirSync(path.join(member, DEPLOYMENTS_DIR)).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/** What a person is told when a 1.4 daemon path is asked for in a member home. */
export function memberHomeDaemonRefusal(mycoHome: string): string {
  return `${mycoHome} is a Myco 2.0 member home, so the Myco 1.4 local daemon does not run here. `
    + 'Use the Deployment through the member credential instead: `myco tool call <tool> --credential registry`, '
    + 'and `myco member provision <agent>` to give an agent the member MCP entry and hooks.';
}
