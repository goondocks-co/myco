/**
 * A member's skills, kept current in each agent's global skills folder (#1499).
 *
 * The member-home gate turns off the 1.4 detection pass that linked skills (#1478), so skills a member home holds are
 * seeded and linked here, by the provisioning a member runs: `<home>/skills` is written from the bundle this binary
 * carries, and each agent's global skills folder gets a link to every skill in it. What another installation put in
 * those folders is its own: a link pointing to something outside this home that exists, or a real file or folder, is
 * left and named. A dead link is replaced. A link into this home for a skill a release retired is removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { managedSkillsDir } from '../install/managed-binary.js';
import { expandHome } from '../paths/home.js';
import { isClaimedByPeer, readClaim, resolveClaimsHome, SYMBIONT_CONFIG_SUBSYSTEM } from '../grove/subsystem-claim.js';
import { ensureManagedSkills } from './managed-skills.js';
import { BUNDLED_SKILLS } from './skills.generated.js';

/** What linking one agent's skills folder came to. */
export interface SkillLinks {
  folder: string;
  linked: string[];
  unchanged: string[];
  removed: string[];
  /** Skills whose place in the folder another installation or the person holds, left as they are. */
  held: Array<{ name: string; by: string }>;
}

/** An agent's global skills folder, with `~` read as this user's home the way every other agent target is. */
export function skillsFolder(target: string): string {
  return path.resolve(expandHome(target));
}

/** Where a link at `link` points, resolved against its own folder; null for anything that is not a link. */
function linkTarget(link: string): string | null {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    return null;
  }
}

/** Whether `candidate` is `root` or inside it. */
const within = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`);

/**
 * Seed `<mycoHome>/skills` and link every bundled skill into `folder`. `replacing` names 1.4 homes whose links are
 * taken over in place (a cutover); any other link that points outside this home is held by another installation.
 */
export function linkMemberSkills(mycoHome: string, folder: string, replacing: readonly string[] = []): SkillLinks {
  const result: SkillLinks = { folder, linked: [], unchanged: [], removed: [], held: [] };
  // A home whose agent configuration another installation claims (a live 1.4 install on it) keeps its skills as that
  // installation wrote them: nothing here seeds or links over them, and every skill is named as held. A claim a
  // cutover is taking over (`replacing`) does not hold them.
  const claim = readClaim(SYMBIONT_CONFIG_SUBSYSTEM, resolveClaimsHome());
  if (isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, path.resolve(mycoHome), { claimsHome: resolveClaimsHome() })
    && !(claim !== null && replacing.some((home) => path.resolve(home) === path.resolve(claim.owner)))) {
    result.held.push(...Object.keys(BUNDLED_SKILLS).sort().map((name) => ({ name, by: `the installation that claims ${mycoHome}` })));
    return result;
  }
  ensureManagedSkills(mycoHome);
  const source = path.resolve(managedSkillsDir(mycoHome));
  const legacy = replacing.map((home) => path.resolve(home));
  const names = Object.keys(BUNDLED_SKILLS).sort();
  fs.mkdirSync(folder, { recursive: true });
  for (const name of names) {
    const link = path.join(folder, name);
    const wanted = path.join(source, name);
    const points = linkTarget(link);
    const occupied = points === null && fs.existsSync(link);
    if (occupied) { result.held.push({ name, by: 'a file or folder of its own' }); continue; }
    if (points === wanted) { result.unchanged.push(name); continue; }
    // A link to something that no longer exists is dead, whoever made it, and is replaced.
    if (points !== null && fs.existsSync(points) && !within(points, source) && !legacy.some((home) => within(points, home))) {
      result.held.push({ name, by: points });
      continue;
    }
    if (points !== null) fs.unlinkSync(link);
    fs.symlinkSync(wanted, link, 'dir');
    result.linked.push(name);
  }
  // A link into this home for a skill the bundle no longer carries is this home's to remove.
  let entries: string[] = [];
  try { entries = fs.readdirSync(folder); } catch { entries = []; }
  for (const name of entries) {
    if (names.includes(name)) continue;
    const link = path.join(folder, name);
    const points = linkTarget(link);
    if (points !== null && within(points, source)) {
      fs.unlinkSync(link);
      result.removed.push(name);
    }
  }
  return result;
}
