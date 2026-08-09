/*
 * Copyright 2026 Myco Contributors
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
/**
 * The residency wire codec — how a project's rows cross to the host and back
 * WITHOUT loss.
 *
 * Residency is not team sync. Sync replicates a NARROWED projection to a shared
 * cloud replica and deliberately strips local-only columns (`sanitizeSyncPayload`);
 * residency moves YOUR OWN project to a host that holds the single copy, and the
 * round trip is lossless BY CONTRACT. So residency does NOT route through the
 * sync sanitizer — it keeps every column — and it handles the one thing plain
 * JSON cannot: a BLOB.
 *
 * THE BLOB PROBLEM. `JSON.stringify(new Uint8Array([1,2,3]))` is `{"0":1,"1":2,"2":3}`,
 * a plain object the receiver cannot bind (`Binding expected string, TypedArray,
 * …`). Measured: attach wedged on any vault with an attachment, because
 * `attachments.data` round-tripped through JSON as an object and threw on every
 * retry. The codec wraps a BLOB as `{ [BLOB_TAG]: base64 }` on the way out and
 * restores the Buffer on the way in — keyed on the VALUE being bytes, so a new
 * BLOB column anywhere in the carried set is covered with no per-table change.
 */

/** The single key that marks a base64-encoded BLOB on the wire. Deliberately
 *  ungainly so it cannot collide with a real column value. */
const BLOB_TAG = '__myco_blob_b64__';

interface WireBlob { [BLOB_TAG]: string }

function isWireBlob(value: unknown): value is WireBlob {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as Record<string, unknown>)[BLOB_TAG] === 'string'
  );
}

/**
 * Encode a source row for the residency wire: BLOB columns become base64
 * wrappers, every other value passes through unchanged, and NOTHING is stripped
 * (full fidelity — the opposite of `sanitizeSyncPayload`). `tableName` is
 * accepted so the signature matches the sync transform it replaces on the
 * residency send path, even though the codec is column-type driven, not
 * table-driven.
 */
export function residencyEncodeRow(_tableName: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      out[key] = { [BLOB_TAG]: Buffer.from(value).toString('base64') };
    } else if (Buffer.isBuffer(value)) {
      out[key] = { [BLOB_TAG]: value.toString('base64') };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Decode a wire row before it is bound into SQLite: base64 BLOB wrappers become
 * Buffers, everything else passes through. Idempotent on a row with no wrappers,
 * so it is safe to run over every applied row.
 */
export function residencyDecodeRow(row: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(row)) {
    if (isWireBlob(value)) {
      copy ??= { ...row };
      copy[key] = Buffer.from(value[BLOB_TAG], 'base64');
    }
  }
  return copy ?? row;
}
