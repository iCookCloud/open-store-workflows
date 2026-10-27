# @osw/build-out

Workflow 05 of Open Store Workflows. This package depends on `@osw/core`; it is developed in the shared repository and is independently packageable. npm publication requires separate approval.

From this package directory after installing and building the workspace:

```sh
pnpm test
pnpm examples
pnpm examples:generate
```

```sh
pnpm exec osw build-out run \
  --assets examples/assets \
  --in examples/inputs/build-out.json \
  --approvals examples/approvals/build-out.json \
  --now 2026-01-30T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/build-out
```

`BuildOutInput` carries complete `site: SiteDecision`, `bom: Bom`, and `delivery: DeliveryPlan` envelopes, plus the quote currency, phase and acceptance template IDs. The build-out example consumes synthetic upstream snapshots; the seven packages have independent examples rather than one continuous end-to-end store run. Its upstream listing and BOM-case references are external to this sample asset directory, so `--record` reports partial writeback until their owning slots and records are supplied.

- Map every lease landlord-work item in `landlordScope`; those line IDs are excluded from the contractor quote. `quantities` and `installOverrides` use stable line IDs. Quantities require an operator confirmation.
- Installation rates match by unit, category, kind, jurisdiction, priority and optional name substring. Labor rates, FX, bid minimum, crew size, hours per day, workdays and verification tolerances come from parameters. Missing or ambiguous values block; there are no business defaults.
- Quotes round unit prices before multiplying quantities. Goods use the same two rounding points; labor includes the rounding remainder so goods plus labor equal the charged line totals. Freight comes only from `DeliveryPlan`. `projectClientQuote()` exposes a whitelist of customer fields and material names, excluding source prices, factories, rates and provenance.
- Submit the last accepted artifact as `previousPlan` when revising a quote. Direct edits then require a change order. Each change binds the current quote hash and needs distinct owner and contractor approvals; the contractor approval must identify `input.contractor`. Signed price and calendar-day schedule deltas must match recalculation. Pending changes remain proposed, and rerunning applies each change once from the original quote.
- Each line must map to exactly one phase; split a line if work belongs to multiple phases. Arrival constraints apply per task. Local purchases require explicit `localAvailability` dates. The calendar supports ISO weekdays; holidays and crew resource leveling are outside this version. Checkpoints require evidence before dependent actual work or final acceptance.
- Completion checks distinguish an expected delivery from a receipt, compare installed quantities and site measurements, and create blocking landlord punch items for missing lease delivery. Missing evidence produces an open plan; complete evidence requires a matching owner approval. Accepted and conditional plans carry `acceptedAt`; every open minor punch item needs a due date. The acceptance signature also binds the completion date, checkpoints and quote revision.

The seven step exports are `takeoff`, `estimateHours`, `priceQuote`, `levelBids`, `schedule`, `track`, and `accept`; CLI and MCP discover them from the installed package. Steps only return verification intentions. They never persist changes themselves.

## Package-owned examples

The `examples/` tree, `scripts/generate-examples.mjs`, and `scripts/check-examples.mjs` belong to this package. Generation does not import another workflow or write a shared repository fixture. Frozen upstream contracts live in `examples/upstream/`; replace those JSON envelopes intentionally when testing a different handoff. The checker regenerates into a temporary directory, compares the complete tree, then runs the real CLI with and without approval.

License: Apache-2.0.
