/** Inclusive window in epoch seconds. */
export interface DiagnosticWindow {
  since: number;
  until: number;
}

export interface CollectorError {
  layer: string;
  error: string;
}

export interface BundleManifest {
  bundle_format: 1;
  myco_version: string;
  schema_version: number;
  platform: string;
  grove_id: string;
  window: DiagnosticWindow;
  include_content: boolean;
  generated_at: number;
  /** The daemon's BOOTSTRAP vault dir passed to `runChecks` for the doctor collector. */
  doctor_vault_dir: string;
  /** Zip-relative paths of every file present. */
  files: string[];
  collector_errors: CollectorError[];
  /** Honest-absence notes, e.g. "session <id>: no surviving buffer (converged buffers are deleted)". */
  notes: string[];
}

/** One file destined for the zip. Strings are UTF-8 encoded at zip time. */
export interface BundleFile {
  path: string;
  data: string | Uint8Array;
}
