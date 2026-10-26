# Open Store Workflows

Reusable, data-driven workflows for planning and operating a store. Business rules live in code; asset records, prices, partners and approvals come from the operator's own sources.

[简体中文](README.zh-CN.md)

[Source](https://github.com/iCookCloud/open-store-workflows) · [CI](https://github.com/iCookCloud/open-store-workflows/actions/workflows/ci.yml)

This implementation includes the shared core, **store-concept**, and **build-out** workflows. It produces a versioned `StoreSpec` from a concept brief, calculation templates, menus, site requirements and operating-store actuals. The build-out workflow produces a `BuildPlan` from site, BOM and delivery artifacts, with quantity confirmation, quotes, bid comparisons, working-day schedules, signed changes and completion evidence. The other five workflow implementations and production-system integration are separate work.

## Packages

| Package | Responsibility |
| --- | --- |
| `@osw/core` | Schemas, hashing, units, money, conditions, parameter resolution, asset sources and artifact contracts |
| `@osw/store-concept` | Concept selection, menus, investment and breakeven calculations, calibration, site requirements and release approval |
| `@osw/build-out` | Construction quantities, installation rates, customer quotes, bids, arrival-constrained schedules, change orders and completion acceptance |
| `@osw/mcp` | A stdio MCP server exposing the same steps and schemas as the CLI |

The portable core and workflows have no Node builtin dependency. File access and command-line execution live in `@osw/core/node`; the HTTP client lives in `@osw/core/http`. Workflow packages import only `@osw/core`.

## Local development

Use Node.js 22 or later and the pnpm version declared in `package.json`.

```sh
corepack enable
git clone https://github.com/iCookCloud/open-store-workflows.git
cd open-store-workflows
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Run the synthetic example without approvals to inspect its blocking needs (exit code `2`):

```sh
pnpm osw store-concept run \
  --assets examples/sample-store/assets \
  --in examples/sample-store/inputs/store-concept.json \
  --now 2026-01-01T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/pending
```

Then use the example approvals (exit code `0`):

```sh
pnpm osw store-concept run \
  --assets examples/sample-store/assets \
  --in examples/sample-store/inputs/store-concept.json \
  --approvals examples/sample-store/approvals/store-concept.json \
  --now 2026-01-01T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/approved
```

The output directory contains each step result, `result.json`, and `artifact.json`. A blocked run writes `null` to `artifact.json`; a step not reached in the current run has a `null` step file. Reusing an output directory therefore cannot expose a prior successful artifact as the current result. Commands do not write back to asset sources unless `--record` is passed. Exit code `1` indicates an execution error; `3` means the workflow produced output but one or more requested writebacks did not succeed.

```sh
pnpm osw slots --json-schema .osw/schemas
OSW_ASSETS=examples/sample-store/assets node packages/mcp/dist/stdio.js
```

The MCP server discovers installed `@osw/*` workflow packages. Its query tool limits pages to 50 records. Writeback tools are registered only when the server is started with `--allow-record`. HTTP credentials are read from `OSW_TOKEN`, never from committed inputs. FileSource writebacks use the system `flock` command for cross-process locking; reading files does not require it. If `flock` is unavailable, writes fail explicitly instead of proceeding without a lock.

## Construction workflow

```sh
pnpm osw build-out run \
  --assets examples/sample-store/assets \
  --in examples/sample-store/inputs/build-out.json \
  --approvals examples/sample-store/approvals/build-out.json \
  --now 2026-01-30T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/build-out
```

`BuildOutInput` carries complete `site: SiteDecision`, `bom: Bom`, and `delivery: DeliveryPlan` envelopes, plus the quote currency, phase and acceptance template IDs. The example includes synthetic upstream snapshots; it does not claim to run the five workflows that are still separate work. Its upstream listing and BOM-case references are external to this sample asset directory, so `--record` reports partial writeback until their owning slots and records are supplied.

- Map every lease landlord-work item in `landlordScope`; those line IDs are excluded from the contractor quote. `quantities` and `installOverrides` use stable line IDs. Quantities require an operator confirmation.
- Installation rates match by unit, category, kind, jurisdiction, priority and optional name substring. Labor rates, FX, bid minimum, crew size, hours per day, workdays and verification tolerances come from parameters. Missing or ambiguous values block; there are no business defaults.
- Quotes round unit prices before multiplying quantities. Goods use the same two rounding points; labor includes the rounding remainder so goods plus labor equal the charged line totals. Freight comes only from `DeliveryPlan`. `projectClientQuote()` exposes a whitelist of customer fields and material names, excluding source prices, factories, rates and provenance.
- Submit the last accepted artifact as `previousPlan` when revising a quote. Direct edits then require a change order. Each change binds the current quote hash and needs distinct owner and contractor approvals; the contractor approval must identify `input.contractor`. Signed price and calendar-day schedule deltas must match recalculation. Pending changes remain proposed, and rerunning applies each change once from the original quote.
- Each line must map to exactly one phase; split a line if work belongs to multiple phases. Arrival constraints apply per task. Local purchases require explicit `localAvailability` dates. The calendar supports ISO weekdays; holidays and crew resource leveling are outside this version. Checkpoints require evidence before dependent actual work or final acceptance.
- Completion checks distinguish an expected delivery from a receipt, compare installed quantities and site measurements, and create blocking landlord punch items for missing lease delivery. Missing evidence produces an open plan; complete evidence requires a matching owner approval. Accepted and conditional plans carry `acceptedAt`; every open minor punch item needs a due date. The acceptance signature also binds the completion date, checkpoints and quote revision.

The seven step exports are `takeoff`, `estimateHours`, `priceQuote`, `levelBids`, `schedule`, `track`, and `accept`; CLI and MCP discover them from the installed package. Steps only return verification intentions. They never persist changes themselves.

## Semantics that matter

- Missing or ambiguous business parameters produce structured `needs`. There are no fallback business prices, exchange rates or operating assumptions in code.
- Approval binds to the hash of the approved content. Changing a menu or final specification requires a fresh matching approval.
- Steps read assets and return verification and fill intentions. The runner performs explicitly requested writes.
- Asset hashes supplied by a source are authoritative, including when fields have been redacted. Incompatible slot major versions fail explicitly.
- Monetary amounts are rounded by currency at line level. Overrides are already in the requested output currency.
- Calibration excludes a template's own source stores and does not verify a user override against the template.
- The source protocol uses bounded filtering and cursor pagination. Unknown fields and unsupported operations are rejected.

## Verification and synthetic data

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm boundaries
pnpm runtime
pnpm examples
```

`examples/sample-store` describes **Example Noodle Bar** in synthetic jurisdiction `XE`. Its records are generated from invented constants and a fixed seed; they are not anonymized production data. `pnpm examples` regenerates fixtures in a separate temporary directory, compares the committed golden output, exercises the approval gate, and records a deliberately failing verification. Regenerate committed fixtures intentionally with `node scripts/gen-examples.mjs` and review changes.

The privacy gate requires a nonempty denylist outside the repository. Put one literal per line, or prefix a regular expression with `re:`. Literal matching normalizes Unicode width, case and whitespace. General credential, path, contact and domain checks always run.

```sh
export OSW_PRIVATE_DENYLIST=/secure/workflow-denylist.txt
pnpm scan
node scripts/scan-private.mjs --history
node scripts/scan-private.mjs --tarball /secure/package.tgz
git config core.hooksPath .githooks
```

The pre-push hook scans the blobs reachable from outgoing commits; the full-history mode scans all local refs. GitHub Actions runs build, tests and examples for pushes and pull requests. The main-branch privacy job requires the `OSW_PRIVATE_DENYLIST_CONTENT` repository secret and scans the complete history. Private denylist values are never passed to pull-request jobs. The optional Woodpecker pipeline uses an `osw_private_denylist` secret. Without a configured denylist, scanning fails closed. npm publication and production integration remain separate from publishing this source repository.

## License

Apache-2.0. See [LICENSE](LICENSE).
