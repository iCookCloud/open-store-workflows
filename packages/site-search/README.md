# @osw/site-search

Second workflow: find premises, compare advertised claims with independent surveys, approve a shortlist, draft an LOI, review lease changes with counsel, and collect signing evidence. Produces the shared `SiteDecision` artifact at `chosen`, `loi`, and `signed` stages.

Only `@osw/core` is a runtime dependency. Each exported step is deterministic for its supplied context and reads assets through `AssetReader`; only the host runner records verification intents.

## Run the synthetic example

From this package directory, after installing dependencies and building the workspace:

```sh
pnpm exec osw site-search run \
  --assets examples/assets \
  --in examples/input.json \
  --approvals examples/approvals.json \
  --providers examples/providers.mjs \
  --now 2026-01-10T12:00:00Z \
  --actor example-test \
  --out-dir .osw/site-search
```

Use `pending-approvals.json` to stop at `signLease` with exit code 2. With all example approvals and signing receipts, exit code 0 produces a schema-valid signed artifact. These are explicitly synthetic test materials, including the PDF-like byte fixtures; they are not signed legal documents.

`pnpm examples` verifies both CLI exits and the golden artifact hash. Regenerate the invented fixtures with `pnpm examples:generate`, then review the diff. No private data is read by the generator.

## Inputs and results

The workflow exports ten `StepDef` objects through `workflow.steps`:

`screenListings` → `scanSurroundings` → `shortlist` → `assessSite` → `surveySite` → `chooseSite` → `matchCounsel` → `draftLoi` → `reviewLease` → `signLease`.

Call any step directly with its declared input and a `StepCtx`, or run the full workflow with an object keyed by those names (see `input.json`). Missing input produces an input need at that step. The runner injects fresh upstream outputs into downstream inputs, verifies shortlist membership, and stops on a blocking need. Intermediate `chosen` and `loi` artifacts remain in step outputs; the top-level artifact is null when the run is blocked.

- Four package slots: `listing`, `place-observation`, `competitor-query`, and `trade-area`. The shared `template`, `party`, and `params` slots come from core.
- Area filters branch by `m2` and `ft2` before pushing down numeric comparisons. Sorting is lexicographic, without a composite score.
- Unknown price, additional charges, food-use permission, old evidence, or estimated population stay pending. Food-use confirmation uses an observed boolean `ConditionReading` with key `foodUse`.
- A JSON `site-dd-checklist` template contains `{ "checks": [{ "key": "zoning" }, ...] }`. Checklist evidence is supplied in `assessSite.dueDiligence`. Availability is an independent observed boolean in `assessSite.availability`.
- Survey results distinguish suitability from truth: a site can satisfy the store requirement while its advertised measurement receives a failing verification. Evidence from the same listing source cannot confirm that source.
- `freezeDocument(template, kind, content, terms)` produces a document snapshot. Its `contentHash` binds **both the text and structured business terms**, excluding mutable document-signing metadata. Changing either invalidates approvals. All lease/rider/guarantee snapshots must share reconciled final terms.
- Drift is reported for every changed declared `termKey`. Counsel must acknowledge each key as a separate token in the approval note. Lawyer approval needs `role: "lawyer"` and a current `party` reference.
- Signatures require current hash-bound approvals, current signer assets, fresh observations or explicit waivers, and matching signed-file/audit hashes. The full run also repeats financial, availability, population, and due-diligence checks before signing.

Business limits, tolerance values, exchange rates, and freshness policy come from parameters. They have no price or threshold defaults. Provider adapters never receive asset write methods.

## External adapters

Import adapters and types from `@osw/site-search/providers`. A CLI/MCP adapter module exports `createProviders({ now })`, returning `{ providers, stores }`. Pass the module explicitly with `--providers path/to/module.mjs`; MCP also accepts `OSW_PROVIDERS`. This loads local JavaScript selected by the host, so treat adapter files as executable application code.

- `googlePlaces({ apiKey, fetch? })`: text search and identity-checked place details, minimal field masks, no raw-content caching by default. Persisted scan output contains provider IDs and curated classifications. Raw provider content is never included in workflow output. [Google's Places policy](https://developers.google.com/maps/documentation/places/web-service/policies) distinguishes Place ID retention from content caching.
- `nominatim({ userAgent, quota, cache, cacheSeconds, fetch? })`: identifying User-Agent, successful-result caching, and a shared one-request-per-second quota. The host supplies storage for its whole application. [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).
- `csvListingFeed(csv, map)`: parses quoted CSV and validates explicit column mappings into listing drafts. Draft ingestion is a returned action need. It does not scrape listing websites.
- `manualEsign(receipts)`: collects host-uploaded signed bytes and audit certificates, checks signer identities, frozen snapshot hashes, and file hashes. It does not initiate signatures or claim to authenticate a person. DocuSign/webhook integration is outside this release.
- `MemoryQuotaStore(clock)` and `MemoryCacheStore(clock)` support a single local process. Production hosts must inject shared atomic quota storage and an appropriate cache.

External API tests use synthetic responses. Live paid API calls, production asset-center integration, and public npm publication are not part of these checks.

## Package-local verification

```sh
pnpm test
pnpm examples
pnpm examples:generate
```

The tests and deterministic example tools run from this package directory. Upstream workflow data is exchanged as core artifact JSON snapshots, without importing another workflow’s example scripts.
