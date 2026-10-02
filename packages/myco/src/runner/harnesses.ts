/**
 * Every harness a worker can drive, and the facts that differ between them.
 *
 * Each harness's manifest declares them (its `runner:` block, generated into
 * `harnesses.generated.ts` and myco-shared); this module types them and reads
 * them. Detection, the three drivers and `myco doctor` all read this one table,
 * so a fact about a harness is stated once, in its manifest. The facts that differ:
 *
 * - **`binary`** — what to look for on PATH.
 * - **`launch`** — three shapes, not two. A harness may speak the protocol
 *   through its own binary (`opencode acp`, `cursor-agent acp`), through no
 *   protocol at all so a native driver reads its own stream (Claude Code,
 *   Codex), or through a sidecar binary its vendor ships separately.
 * - **`credential`** — where the harness keeps its login. Detection reads a
 *   file or asks the binary; it never asks the network, and a registry entry
 *   never answers it, so the probe is always of the tool itself.
 * - **`isolation`** — how a per-run configuration becomes the harness's ONLY
 *   source of tools. This differs per harness and only one of the three is
 *   airtight, which is why it is a field rather than one rule applied thrice.
 * - **`asking`** — how a harness is made to ask before a call, so the run's
 *   grant decides every call a protocol driver is asked about, or what bounds a
 *   run where the harness never asks. A harness whose own configuration would
 *   approve a run's calls unasked, and that a run cannot be given a
 *   configuration of its own, is offered by no worker.
 * - **`accounting`** — the reported format, launch fallback, provider decoding
 *   and token coverage a driver reads for the run's accounting.
 * - **`sourceGit`** — whether a source run's shell commands reach the run's
 *   own `git`, so the grant offers Git reads only where they can be held to
 *   reads of the checkout.
 */

import { expandHome } from '../paths/home.js';
import { PROFILE_HARNESSES, HARNESS_ASKING, canOfferHarness, type Asking, type ProfileCapability } from '@goondocks/myco-shared/execution-profile';
import { HARNESS_FACTS } from './harnesses.generated.js';

/** How a harness is started so it speaks the agent protocol, or that it does not speak it at all. */
export type LaunchShape =
  | { kind: 'native' }
  | { kind: 'subcommand'; args: readonly string[] }
  | { kind: 'sidecar'; binary: string };

/** Where a harness keeps its login, and how a probe reads it without printing it. */
export type CredentialProbe =
  | { kind: 'file'; path: string; requires: readonly string[] }
  | { kind: 'command'; args: readonly string[] }
  /** A file, with a command to fall back to where the platform keeps the value in its keyring instead. */
  | { kind: 'file-or-command'; path: string; requires: readonly string[]; args: readonly string[] };

/**
 * How a per-run configuration becomes the harness's only tool source.
 *
 * `flag` is airtight: the harness is told to use this configuration and ignore
 * every other. `home` is airtight for the TOOL surface, by giving the harness a
 * configuration directory of its own: what the machine configured is carried
 * into it, its login included, and the servers it configured are not, so no
 * server but the run's is in reach. What a home does not isolate is the rest of
 * that configuration, which flows into a run queued from elsewhere, so a driver
 * that redirects a home pins what a queued run cannot inherit. `additive` is
 * neither: the run's servers are added to whatever the harness already has, and
 * a worker cannot make that exclusive from outside.
 */
export type Isolation =
  | { kind: 'flag'; args: readonly string[] }
  | { kind: 'home'; env: string }
  | { kind: 'additive' };

export type { Asking } from '@goondocks/myco-shared/execution-profile';

/**
 * Whether a source run on this harness may read Git history. `shim`: the
 * harness runs a shell command with the run's own `git` first on its PATH, so
 * the run is granted Git read commands. `none`: it does not, and a source run
 * reads its checkout through its file tools alone.
 */
export type SourceGit = 'shim' | 'none';

export interface HarnessAccounting {
  reported: 'claude-stream' | 'codex-session' | 'acp-session';
  modelSources: readonly string[];
  launchFallback: 'none' | 'resolved-config';
  primarySources?: readonly string[];
  modelVariants?: readonly { suffix: string; context: '1m' }[];
  zeroDollars?: 'reported' | 'unavailable';
  provider: { kind: 'environment'; default: string; selectors: readonly { variable: string; provider: string }[]; unknownIfSet: readonly string[] } | { kind: 'fixed'; id: string } | { kind: 'session-config'; default: string } | { kind: 'model-prefix' } | { kind: 'unavailable' };
  tokenScope: 'attempt' | 'unverified';
  lastResponseVersions?: readonly string[];
}

/** Which field of a listed entry holds each fact a catalog keeps of a model, as a dotted path (`a[].b` reads every entry's `b`). */
export interface CatalogFields { id: string; label?: string; isDefault?: string; resolvesTo?: string; upgrade?: string; efforts?: string }

/**
 * How a worker lists the models a harness can run (`models.ts`): one id per line of a command's output, or the answer
 * to messages sent on its standard input. `provider: id-prefix` names each model's provider as its id's first segment.
 */
export type ModelListing =
  | { kind: 'command'; args: readonly string[]; env?: Readonly<Record<string, string>>; format: 'lines'; provider?: 'id-prefix' }
  | {
    kind: 'exchange'; args: readonly string[]; env?: Readonly<Record<string, string>>;
    send: readonly Readonly<Record<string, unknown>>[];
    answer: { where: Readonly<Record<string, string | number>>; list: string };
    fields: CatalogFields; provider?: 'id-prefix';
  };

export interface Harness {
  id: string;
  binary: string;
  launch: LaunchShape;
  credential: CredentialProbe;
  isolation: Isolation;
  asking: Asking;
  sourceGit: SourceGit;
  accounting: HarnessAccounting;
  profile: ProfileCapability;
  /** How a worker lists the models it can run; absent where it lists none. */
  models?: ModelListing;
}

/** What a harness's manifest declares of how a worker runs it (`runner.worker`): all but what the shared tables hold. */
export type HarnessFacts = Omit<Harness, 'profile' | 'asking'> & { modelSetting: ProfileCapability['model'] };

/**
 * Every harness a worker can drive, in the order it ranks them, from the manifests: how a worker runs it
 * (`harnesses.generated.ts`), how it is held to a run's grant (`HARNESS_ASKING`), and its efforts from its tier profile.
 */
export const HARNESSES: readonly Harness[] = HARNESS_FACTS.map(({ modelSetting, ...facts }) => ({
  ...facts,
  asking: HARNESS_ASKING[facts.id]!,
  profile: { model: modelSetting, efforts: PROFILE_HARNESSES[facts.id]!.allowedEfforts },
}));

const BY_ID = new Map(HARNESSES.map((h) => [h.id, h]));

/** Whether a run on this harness is held to its grant or its sandbox, and so whether a worker may offer it. */
export function offerable(harness: Harness): boolean {
  return canOfferHarness(harness.asking);
}

/** The harness this id names, or null when the worker serves none by that name. */
export function harnessById(id: string): Harness | null {
  return BY_ID.get(id) ?? null;
}

/**
 * The absolute path of the file this harness keeps its login in, or null where
 * only its binary can answer.
 *
 * The declaration above is the one place that path is written. Detection reads
 * a login through this, and so does a driver that has to carry one into a run,
 * so a harness that moves its credential file is followed everywhere by the
 * edit that moves it here.
 */
export function credentialFile(harness: Harness): string | null {
  const probe = harness.credential;
  if (probe.kind === 'command') return null;
  return expandHome(probe.path);
}
