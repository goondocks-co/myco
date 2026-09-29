# Recall gold set: provenance

This fixture freezes one Project's memory and 48 real user prompts, so that CI can score prompt-time injection (`POST /context/prompt`) deterministically on both front doors.

## Snapshot

Taken 2026-09-29 from the dogfood Deployment, read-only (D1 `SELECT`s, Vectorize `get_by_ids`, Workers AI embeddings).

- **Spores.** `corpus.json` holds all 368 active spores with a ready embedding receipt. That is exactly the set production calibrates hubness over: neighbour statistics recomputed from `vectors.bin` match production to within 1e-15.
- **Plans.** `corpus.json` also holds the 14 plans. Each keeps its title and status; the body is replaced by a fixed placeholder, because injection renders only the title and the vector is frozen.
- **Prompts.** `gold.json` holds 48 real user prompts. Each case records its source (the 1.4 dogfood vault, 2026-03 to 08, or the 2.0 Deployment, 2026-08 to 09), harness, date, session id and prompt id.
- **Judgements.** The owner reviewed every case and agreed with the suggested verdict. The five open cases (rp-02, rp-12, rp-28, rp-32, rp-39) are negatives.
- **Vectors.** `vectors.bin` holds production `@cf/baai/bge-m3` vectors: 1024 float32 values per row, little-endian. `vectors.json` indexes the rows.
  - Spore and plan rows are the stored Vectorize values; their zero padding past 1024 dimensions is dropped.
  - Prompt rows are the Workers AI embedding of the prompt exactly as it was sent.

## Embedding keys

Each row's `embedKey` is the sha256 of the exact text the server passes to `EmbeddingProvider.embed`:
- a spore: `content + "\n"` (its `context` is empty), per `db/schema-v20.ts`;
- a plan: `title + "\n" + content`;
- a case: the prompt text.

A fixture provider answers `embed(text)` by that key and throws on any text it does not hold.

## Redactions

Applied to the committed text only. The vectors are the unredacted originals.

| Where | Replaced | With |
|---|---|---|
| gotcha-91d22180 | a private VM IP address | `<vm-ip>` |
| decision-dbb58981, gotcha-c3919ebd | the live Deployment's hostname | `<deployment-host>` |
| gotcha-0b64daeb | an absolute home path | `~` |
| gotcha-84b4659c | a container home path (the fixture gate forbids `/home/<name>`) | "the bun user's home directory" |
| rp-05 | a local screenshot path | `[screenshot]` |

A scan for keys, tokens, JWTs, private keys, password assignments, emails and phone numbers found nothing in the spores, plan titles or prompts.

**Light scrub of the committed text** (owner decision, 2026-09-29):
- the owner's first name is replaced with "the owner" in `content` and `agentLine`. This touches 48 spores.
- `gotcha-91d22180`: the host's sleep window, wake durations and run id are removed from `content`.
- `gotcha-e95632f5`: where the recovery key is stored (1Password) is removed from `content`.

Project names (for example `unifi-mcp`) and the prompts' wording are kept verbatim.

All redactions and scrubs apply to committed text only. **Every vector in `vectors.bin` is production's vector of the original, unscrubbed text**, and none was re-embedded. The `embedKey` of a changed row is the sha256 of its committed text, so the fixture provider still answers the seeded text with the production vector. The changed fields are listed under `scrub` in `corpus.json`.

## Refreshing

When the corpus moves:
1. Re-run the read-only freeze procedure from a scratchpad. It is not in source.
2. Have the owner re-judge the cases whose served block changed.
3. Re-record the baseline.
