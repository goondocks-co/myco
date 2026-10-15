# Recall gold set: provenance

This fixture freezes one Project's memory and 48 real user prompts, so that CI can score prompt-time injection (`POST /context/prompt`) deterministically on both front doors.

## Snapshot

Taken 2026-09-29 from the dogfood Deployment, read-only (D1 `SELECT`s, Vectorize `get_by_ids`, Workers AI embeddings).

- **Spores.** `corpus.json` holds all 368 active spores with a ready embedding receipt. That is exactly the set production calibrates hubness over.
- **Plans.** `corpus.json` also holds the 14 plans. Each keeps its title and status; the body is replaced by a fixed placeholder, because injection renders only the title and the bodies carry working notes this repository should not publish.
- **Prompts.** `gold.json` holds 48 real user prompts. Each case records its source (the 1.4 dogfood vault, 2026-03 to 08, or the 2.0 Deployment, 2026-08 to 09), harness, date, session id and prompt id.
- **Judgements.** The owner reviewed every case and agreed with the suggested verdict. The five open cases (rp-02, rp-12, rp-28, rp-32, rp-39) are negatives. On 2026-10-12 the coordinator added the expected live plan `a3b1e332-96a2-56e0-9afa-01876916c3a3` (Myco 2.0 delivery reset) to rp-43. That additional plan judgment is pending owner review, as recorded in `expectedPlanReview`; it is separate from the original `ownerReview`.

## Vectors

`vectors.bin` holds `@cf/baai/bge-m3` vectors: 1024 float32 values per row, little-endian. `vectors.json` indexes the rows.

**Every vector embeds the committed text of its row.** A vector of text other than what is committed would let anyone holding the public model test guesses for a redaction and keep the closest match, so no committed row carries one.

- **The same text as production.** Where the committed text is exactly what production embedded, the row keeps production's stored Vectorize vector, with its zero padding past 1024 dimensions dropped. That covers 314 spores and 46 prompts; each prompt row is the Workers AI embedding of the prompt as it was sent.
- **Different text.** Every other row was re-embedded from its committed text with the same model through Workers AI:
  - 54 spores (the redactions and scrubs below);
  - all 14 plans (placeholder body);
  - 2 prompts (rp-05, rp-47).

  The re-embedded spores sit at cosine 0.97–1.00 (mean 0.99) from their production vectors, the prompts at 0.95–0.99, and the plans at 0.56–0.70 (a placeholder body in place of the real one).

**Fidelity to production.** Before re-embedding, the fixture served the same block as the live production retrieval the owner reviewed for 46 of 48 cases. The two differences came from exact float64 cosine here against Vectorize's approximate float32 search in production:
- rp-25 dropped `gotcha-182949e0` at the relevance band edge;
- rp-36's sixth plan differed.

After re-embedding, the served blocks move where the re-embedded rows move them:
- 39 cases serve the same spores (32 in the same order);
- 41 serve the same number of plans;
- 10 serve an identical block, plans and order included.

The owner's expected and must-not spore ids are unchanged. The coordinator-added rp-43 plan expectation is pending owner review. The recorded baseline is what the fixture serves, and the gate holds each release to it.

On 2026-10-12 the coordinator approved recording the affine-invariant spore z-score band: recall quality 0.3979 → 0.3962, passing cases 9/48 → 12/48, and named must-not case/item matches 67 → 26, with zero newly introduced matches and zero unexpected plans. This accepts the documented expected-spore losses in favor of precision over recall. `gold.json.precisionRatchet` initially pinned the 26-match ceiling and the 17 affected case IDs; the gate also ratchets against each door's recorded count and case IDs. Both precision checks apply during recording even when recall regressions are explicitly accepted. Original owner spore judgments are unchanged.

Correction 6, directed by the coordinator on 2026-10-12, records leave-one-out prompt statistics and a named minimum of five finite, calibrated spore candidates. Each spore's query-side MP and z-score exclude that spore's own distance. The minimum alone leaves the frozen gold blocks unchanged (100 calibrated candidates per prompt). Leave-one-out changes recall quality 0.3962 → 0.3910, keeps 12/48 passing, and reduces named must-not matches 26 → 25 with none new. rp-31 loses expected `decision-1d95cf73`; rp-45 loses must-not `decision-4e185ae3`; rp-43's expected live plan and served spores are unchanged. The precision ceiling is tightened to 25 matches, with the same 17 allowed affected case IDs. The original owner spore judgments and coordinator-added plan provenance remain unchanged.

**Plan evidence is weaker than spore evidence.** All plan bodies are fixed placeholders, including the delivery-reset plan. Their shared text inflates plan-to-plan similarity, so success on these plan vectors does not establish calibration quality on production plan bodies.

### Historical: multiplicity attempts, superseded by Correction 2

Part 2 bounds the prompt-side normal tail across the complete pre-exclusion spore candidate pool using Bonferroni's union bound. Both local front doors record recall quality 0.3910 → 0.4254, passing cases 12/48 → 15/48, negative cases serving 10/17 → 7/17, named must-not matches 25 → 13, and items served 96 → 57. All twelve previously passing cases still pass; rp-05, rp-28 and rp-36 now pass by serving nothing. The tightened precision ceiling admits only the thirteen remaining matches' case IDs. No new must-not match is introduced.

The task permits withholding borderline items while preserving currently passing cases. Re-recording explicitly accepts expected-spore losses on already-failing positives: rp-01 (`pattern-951fc175`), rp-11 (`gotcha-05b29309`), rp-14 (`gotcha-b6ac3ff4`), rp-18 (`pattern-bca367e0`), rp-22 (`trade_off-eb979ed9`), rp-27 (`gotcha-5aca3e37`), rp-46 (`gotcha-6699d14a`), and rp-47 (`gotcha-ee798214`, `architecture-3f7cbad0`). These cases remain failing; their lower individual recall is included in the aggregate score. Owner judgments and plan vectors are unchanged. The expected rp-43 live plan remains served. This correction establishes no improvement for the reported small-plan-pool false-positive rate; real plan bodies remain absent (#1807).

Correction 1 for PR #1849, directed by the coordinator on 2026-10-15, repairs the dense-topic regression in head `3751cdb3`. The multiplicity reference is fitted from the 90th/95th distance quantiles and their standard-normal coordinates; the relative separation statistic retains its leave-one-out mean and standard deviation. The corpus factor formula is unchanged. A new, stricter standalone admission constraint requires its factor to meet the square root of the existing joint floor; this constraint is a design choice, not implied by the product gate. The two original contract fixtures are restored, keeping the stronger non-empty budget assertion. Twenty-four frozen seeded cluster cases and a pre-exclusion-count regression pin covered-topic admission and session stability.

Measured origin/main → `3751cdb3` → corrected on both local front doors: score 0.3910 → 0.4254 → 0.4578; passes 12/48 → 15/48 → 16/48; negative serving 10/17 → 7/17 → 6/17; must-not matches 25 → 13 → 21; items 96 → 57 → 77; expected positive spores 34 → 25 → 31. All twelve origin/main passes remain passing. The head-only negative pass rp-05 is given back; rp-02 and rp-16 now abstain. Relative to origin/main, only already-failing rp-01, rp-11 and rp-27 lose expected spores under the standalone corpus floor. The corrected ceiling is 21, below the authorized origin/main ceiling of 25. Original owner cases and vectors are unchanged.

The family is the top-100 active vector hits after receipt admission, before session exclusions; it is not the full corpus above 100 items. Real-geometry calibration is measured only at the gold scale, N=368. The reviewer's seeded null simulation still serves on about 100% of prompts at N=200 and N=1000. This known top-K truncation limit is not solved by this correction. The robust fit is validated through half-pool density and the reviewer's 80-topic/top-100 probe; it can collapse when the upper 5–10% no longer provides unrelated background (19 exact matches among 20 is a counterexample). Independent frozen variable-geometry probes at N=20/30/100/368 remove weak-corpus serving with no added loss of strong-corpus positives relative to the same selector without its standalone corpus floor.

### Current: corpus floor, Correction 2

Correction 2 for PR #1849, directed by the coordinator on 2026-10-15: multiplicity bound removed (inert on gold; recall costs measured by review). Prompt-side mutual proximity and separation return to origin/main's leave-one-out distribution, with only the standalone corpus floor retained. The comparison-count parameter, quantile fit, constants and bound-only tests are removed. The floor is a unitless probability constraint at the equal-factor point of the existing joint floor, not a model-dependent similarity threshold. The reviewer's gold sweep from 0.5 through 0.9 shows a smooth precision/recall trade; square root of 0.5 is not a fitted peak. The prior synthetic corpus-evidence probe is a boundary check, since its labels straddle the floor by construction.

Gold remains 0.4578 / 16 passes / 6 negatives serving / 21 must-not / 77 items / 31 expected positive spores. Compared with head `f46321ad`, rp-12, rp-35, rp-46 and rp-47 reorder; all 48 blocks retain their spore/plan memberships and grades. No owner judgments or frozen vectors changed. The original fixtures remain restored. Cluster contracts now include 80% and 90% density at n=100, and single 4-sigma/5-sigma matches are gated at n=10/20/50/100 over multiple frozen backgrounds. Null serving remains near 100% at sampled N>=20, as on main (N=5 is 76% versus main’s 90%); best-of-many is not bounded at any corpus size. The previous bound withheld 8–27% of single 4–5-sigma matches at small corpus sizes and served nothing on 52% of n=100/f=0.8 draws, and all f=0.9 draws. A future bound needs a cluster-robust, low-variance estimator evaluated against cluster, single-match and null-serve rates together.

## Embedding keys

Each row's `embedKey` is the sha256 of the exact text the server passes to `EmbeddingProvider.embed`:
- a spore: `content + "\n"` (its `context` is empty), per `db/schema-v20.ts`;
- a plan: `title + "\n" + content`;
- a case: the prompt text.

A fixture provider answers `embed(text)` by that key and throws on any text it does not hold.

## Redactions and scrubs

Applied to the committed text, which the rows are then embedded from.

| Where | Replaced | With |
|---|---|---|
| gotcha-91d22180 | a private VM IP address | `<vm-ip>` |
| decision-dbb58981, gotcha-c3919ebd | the live Deployment's hostname | `<deployment-host>` |
| gotcha-0b64daeb | an absolute home path | `~` |
| gotcha-84b4659c | a container home path (the fixture gate forbids `/home/<name>`) | "the bun user's home directory" |
| rp-05 | a local screenshot path | `[screenshot]` |
| rp-47 | the name of a production vector index | `<vector-index>` |

A scan for keys, tokens, JWTs, private keys, password assignments, emails and phone numbers found nothing in the spores, plan titles or prompts.

**Light scrub** (owner decision, 2026-09-29):
- the owner's first name is replaced with "the owner" in `content` and `agentLine`. This touches 48 spores.
- `gotcha-91d22180`: the host's sleep window, wake durations and run id are removed.
- `gotcha-e95632f5`: where the recovery key is stored (1Password) is removed.
- `gotcha-ea1915d6`: the recovery-token detail is removed.

Project names (for example `unifi-mcp`) and the prompts' wording are otherwise kept verbatim. `corpus.json` lists the changed fields under `scrub`.

## Refreshing

When the corpus moves:
1. Re-run the read-only freeze procedure from a scratchpad. It is not in source.
   - Re-embed every row whose committed text differs from production's, from the committed text.
2. Have the owner re-judge the cases whose served block changed.
3. Re-record the baseline. The recording prints each regressed, improved and changed case, and refuses regressions unless `MYCO_EVAL_ACCEPT_REGRESSIONS=1` accepts them.
