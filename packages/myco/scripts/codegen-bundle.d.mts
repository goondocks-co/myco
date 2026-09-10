/** Every real text file under `dir`, accumulated into `acc`; a symlink throws. */
export function walk(dir: string, acc?: string[]): string[];

/** The UTF-8 text of `abs`; bytes that are not valid UTF-8 throw. */
export function readTextFile(abs: string): string;

/** The skill directory names under `skillsRoot`, or none when it is absent. */
export function listSkillDirs(skillsRoot: string): string[];

/**
 * Write the generated bundle, or in check mode compare it against what is
 * committed and exit non-zero on a difference.
 */
export function emitBundle(args: {
  outputPath: string;
  pkgRoot: string;
  content: string;
  count: number;
  label: string;
  checkMode?: boolean;
}): void;
