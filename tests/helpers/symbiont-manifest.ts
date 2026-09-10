/**
 * Copyright 2026 Goondocks Co.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  SymbiontManifestSchema,
  TranscriptDiscoverySchema,
  type SymbiontManifest,
  type TranscriptDiscovery,
} from '@myco/symbionts/manifest-schema.js';
import type { z } from 'zod';

/** A manifest as it is authored: defaults and normalizations not yet applied. */
export type SymbiontManifestInput = z.input<typeof SymbiontManifestSchema>;

/** A transcript-discovery block as it is authored, before `retention` defaults. */
export type TranscriptDiscoveryInput = z.input<typeof TranscriptDiscoverySchema>;

/**
 * Build a discovery block through the schema, so `retention` carries the
 * default the manifest loader gives it rather than a value restated here.
 */
export function transcriptDiscovery(
  input: TranscriptDiscoveryInput,
): TranscriptDiscovery {
  return TranscriptDiscoverySchema.parse(input);
}

/**
 * Build a manifest the way `detect.ts` does — through the schema, so defaults
 * (`capabilities`, `hookFields.prompt`, `toolOutput`) are filled and
 * `globalMcpTarget` is normalized to its array shape. A `SymbiontManifest`
 * reaching the installer has always been parsed; fixtures go through the same
 * door so they carry the shape the installer is written against.
 */
export function symbiontManifest(
  input: SymbiontManifestInput,
): SymbiontManifest {
  return SymbiontManifestSchema.parse(input);
}

/**
 * Derive a manifest from an already-parsed one. The overlay is applied to the
 * parsed object and re-parsed, so an overlay that drops a defaulted field gets
 * the default back rather than `undefined`.
 */
export function deriveSymbiontManifest(
  base: SymbiontManifest,
  overlay: Partial<SymbiontManifestInput>,
): SymbiontManifest {
  return SymbiontManifestSchema.parse({
    ...(base as SymbiontManifestInput),
    ...overlay,
  });
}
