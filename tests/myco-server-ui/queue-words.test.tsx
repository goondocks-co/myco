import { describe, expect, it } from 'bun:test';
import { deployWords, queuedWords } from '../../packages/myco-server/ui/src/features/work/words';
import { HELD_BY_WORDS } from '../../packages/myco-server/src/core/limits';
import { CAPABILITY_HOLDS, credentialUnavailable, holdSentence, invalidTaskTier, noModelForTier, profileUnsupported } from '@goondocks/myco-shared/run-holds';
import { HARNESS_NAMES, PROFILE_HARNESSES, REASONING_TIERS } from '@goondocks/myco-shared/execution-profile';
import { MECHANISM_WORDS } from '../helpers/reader-vocabulary';

/** Every holder the server can name: the limits and waits, and each profile hold for every agent this build knows, and one it does not. */
const EVERY_HOLDER: readonly string[] = [
  ...Object.keys(HELD_BY_WORDS), ...CAPABILITY_HOLDS, invalidTaskTier('extract-curate'),
  ...[...Object.keys(PROFILE_HARNESSES), ...Object.keys(HARNESS_NAMES), 'some-new-agent'].flatMap((harness) => [
    profileUnsupported(harness), credentialUnavailable(harness), ...REASONING_TIERS.map((tier) => noModelForTier(harness, tier)),
  ]),
];
/** An agent's id as a reader would meet it: the lowercase id itself, never its name. */
const RAW_ID = new RegExp(`(?<![\\w’'-])(?:${[...Object.keys(PROFILE_HARNESSES), ...Object.keys(HARNESS_NAMES), 'some-new-agent'].map((id) => id.replace(/[-]/g, '\\-')).join('|')})(?![\\w-])`);

describe('a queued run in the reader\'s words', () => {
  it('names its place and what holds it', () => {
    expect(queuedWords({ position: 0, heldBy: 'concurrent_runs' })).toBe('next in line. Waiting for a free slot: this server is already running as many tasks at once as it allows');
    expect(queuedWords({ position: 2, heldBy: 'task_runs_per_hour' })).toBe('2 ahead of it. Waiting until this task’s hourly limit allows another run');
    expect(queuedWords({ position: 1, heldBy: 'fleet' })).toBe('1 ahead of it. Waiting for a free machine: every machine that runs tasks is busy');
    expect(queuedWords({ position: null, heldBy: null })).toBe('next in line. A limit on runs is holding it');
  });

  it('words every holder the server can name, in the server\'s own words', () => {
    for (const [holder, words] of Object.entries(HELD_BY_WORDS)) {
      expect(queuedWords({ position: 0, heldBy: holder })).toBe(`next in line. ${words.replace(/\.$/, '')}`);
    }
  });

  it('says every hold as one whole sentence in the reader\'s words, naming an agent by its name and never by its id', () => {
    expect(EVERY_HOLDER.length).toBeGreaterThan(20);
    for (const holder of EVERY_HOLDER) {
      const sentence = holdSentence(holder);
      expect({ holder, sentence: typeof sentence }).toEqual({ holder, sentence: 'string' });
      const said = sentence!;
      expect({ holder, said, whole: /^[A-Z].*\.$/.test(said) }).toEqual({ holder, said, whole: true });
      expect({ holder, said, rawId: RAW_ID.exec(said)?.[0] ?? null }).toEqual({ holder, said, rawId: null });
      expect({ holder, said, mechanism: /\b(?:workers?|claim(?:s|ed)?|execution profile)\b/i.exec(said)?.[0] ?? MECHANISM_WORDS.exec(said)?.[0] ?? null }).toEqual({ holder, said, mechanism: null });
      expect({ holder, said, stutter: /\bwaiting\b[^.]*\bwaiting\b/i.test(said) }).toEqual({ holder, said, stutter: false });
    }
  });

  it('says what a deploy did to a run, and says nothing about an ordinary one', () => {
    expect(deployWords({ replaced: true, replaces: null })).toBe('Replaced during a deploy');
    // The run it stands in for is never named by its id.
    expect(deployWords({ replaced: false, replaces: 'run_abc' })).toBe('Started again after a deploy');
    expect(deployWords({ replaced: false, replaces: null })).toBeNull();
  });
});
