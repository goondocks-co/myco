/**
 * The harness a hook command names: `--symbiont <name>`, or `--symbiont=<name>` (forgiving of shell quoting on
 * Windows). The installer renders the flag into every hook command it writes, so it is the one source of which harness
 * runs a hook. Undefined when the flag is absent, dangling, or followed by another flag.
 *
 * A leaf, read by the launch preamble before anything else loads, and by hook input normalization.
 */
export function readSymbiontFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--symbiont') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) return next;
    } else if (arg.startsWith('--symbiont=')) {
      return arg.slice('--symbiont='.length);
    }
  }
  return undefined;
}
