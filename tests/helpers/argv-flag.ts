/**
 * A flag's value in a command line, written either as `--flag value` or as `--flag=value`. The Claude Agent SDK
 * builds the command line the harness starts with, and it has written its flags both ways.
 */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const joined = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (joined !== undefined) return joined.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

/** The same lookup, as source for a stub harness written as its own script. */
export const FLAG_VALUE_SOURCE = `const flagValue = (argv, flag) => {
  const joined = argv.find((arg) => arg.startsWith(flag + '='));
  if (joined !== undefined) return joined.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
};`;
