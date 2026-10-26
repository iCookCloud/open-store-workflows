# Open Store Workflows

Reusable, data-driven workflows for planning and operating a store. Business rules live in code; asset records, prices, partners and approvals come from the operator's own sources.

[简体中文](README.zh-CN.md)

[Source](https://github.com/iCookCloud/open-store-workflows) · [CI](https://github.com/iCookCloud/open-store-workflows/actions/workflows/ci.yml)

Implemented workflows include **store-concept** (`StoreSpec`), **site-search** (`SiteDecision`), **fitout-bom** (`Bom`), **landed-delivery** (`DeliveryPlan`), **build-out** (`BuildPlan`), **opening** (`OpeningRecord`), and **replenishment** (`SupplyProgram`). They share the core, CLI and MCP interfaces. All seven workflows are implemented; production-system integration remains separate work.

See the [site-search guide](packages/site-search/README.md) for the synthetic end-to-end example and explicit local `--providers` modules. `pnpm examples:site-search` checks missing-signature-approval exit 2 and completed exit 0.

## Packages

| Package | Responsibility |
| --- | --- |
| `@osw/core` | Schemas, hashing, units, money, conditions, parameter resolution, asset sources and artifact contracts |
| `@osw/store-concept` | Concept selection, menus, investment and breakeven calculations, calibration, site requirements and release approval |
| `@osw/site-search` | Unit-aware listing filters, independent surveys, lease drift, approvals and signing evidence |
| `@osw/fitout-bom` | Case/image review, quantities, model costs, supplier offers, verification and BOM release approval |
| `@osw/landed-delivery` | Compliance review, packing, carrier capabilities, freight quotations, shipment tracking and measured receipts |
| `@osw/build-out` | Construction quantities, installation rates, quotes, bids, arrival-constrained schedules, signed changes and completion acceptance |
| `@osw/opening` | Staffing, SOP coverage, assessments, checklists, release signatures, marketing, reviews and operating-store handoff |
| `@osw/replenishment` | Operating-store segments, supplier matching, newsletter decisions, reorders and upstream verification |
| `@osw/mcp` | A stdio MCP server exposing the same steps and schemas as the CLI |

The portable core and workflow have no Node builtin dependency. File access and command-line execution live in `@osw/core/node`; the HTTP client lives in `@osw/core/http`. Workflow packages import only `@osw/core`.

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

## Fitout workflow

`@osw/fitout-bom` implements case/image review, site and menu quantities, material costing, supplier selection, offer verification, BOM freezing and optional customer quotes. See [the fitout package guide](packages/fitout-bom/README.md). The fully synthetic `examples/fitout-store` fixture is checked by `pnpm examples`.

## Landed delivery

```sh
pnpm osw landed-delivery run \
  --assets examples/sample-delivery/assets \
  --in examples/sample-delivery/inputs/landed-delivery.json \
  --approvals examples/sample-delivery/approvals/landed-delivery.json \
  --now 2026-01-20T12:00:00Z \
  --actor example:delivery-reviewer \
  --out-dir .osw/delivery
```

Omit `--approvals` to receive the required review subjects and hashes with exit code `2`. The same nine steps are discovered by the CLI and MCP: `screenCompliance`, `planShipments`, `assignCarrier`, `applyPartyEdits`, `confirmPacking`, `collectQuotes`, `trackShipment`, `recordArrival`, `summarize`. Edits run before the first packing confirmation so the approval covers the final cells. Run inputs carry `id`, `jurisdiction`, a complete `bom` envelope, an optional `site`/`existing` envelope, and shipment-ID maps for `carriers`, `edits`, `quotes`, `updates` and `arrivals`. The BOM must identify a current preparing or operating store. Individual steps after screening consume the preceding `DeliveryState`; `summarize` returns the artifact. `existing` resumes saved shipments and appends new BOM lines to draft groups only. Supply only new tracking events when resuming; signed receipts cannot be silently replaced.

The six workflow slots are `compliance-category`, `compliance-item`, `product-classification`, `compliance-answer`, `rate-card` and `packing-history`. All use core's kebab-case slot naming. Compliance categories resolve at most six levels, preserve override lineage through retirement, and hold products with malformed trees or ambiguous overrides. Human admission binds the entry without its `subjectHash` and `conclusion`, plus the jurisdiction, evidence versions, supplier/importer subjects and validity horizon. Only a reviewer, or a current lawyer party, may decide admission. Unresolved mandatory entity/SKU evidence prevents `enter`; batch documents stay on the shipment. Synthetic checklists are invented examples, not legal guidance.

Packing groups by origin country, goods class and mode, with seller delivery separated by seller. Urgent international goods use air; local goods use ground. Cross-border declarations require an explicit currency and verified FX; a cross-currency rate of `1` is treated as ambiguous. `pcs`, `set` and `pack` already denote pieces; `carton` requires a carton size. Measured loading access `dock`, `loading_dock` or `有装卸平台` avoids liftgate requests; unknown access produces a need and conservative last-mile requirements. Carrier matching checks both ends and mode on the same lane, including cold-chain and last-mile capabilities. No carrier, price, exchange rate or tolerance is hard-coded.

The host authenticates edit roles before invoking `applyPartyEdits`. Carrier edits fill empty permitted fields only; names, specifications and declared values remain operator-controlled. Confirmed edits require a reason and append an amendment. Transport nodes and actual departure/delivery dates use `trackShipment`, so every entry point has the same state transitions. `viewFor` exposes a delivery view without other carriers' quotes or internal notes; the host must use that view for shared links. Public MCP tools are for the authorized operator, not a replacement for host authentication. Approval roles are `reviewer`/`lawyer` for compliance and `operator` for carrier, packing and quotation decisions; optional `client` acceptance is recorded without blocking execution.

Rates use `shipment`, `m3`, `kg` or `carton` bases. `delivery.tolerance.weightPct`, `delivery.tolerance.volumePct` and `freight.tolerance.rateCardPct` are fractional ratios; `freight.tolerance.transitDays` is an absolute day allowance. Tolerances become required when the corresponding measurement exists. Missing packing cells request follow-up without blocking confirmation; contradictions block. Missing quotes return a usable plan with a request action, while supplied quotes require an explicit current choice. Delivery is distinct from signed receipt. A milestone with any unknown required date stays unknown, and mixed evidence uses the weakest basis. Held goods, shortages or damage keep `allReceived` false.

Only manual or signed observations produce fill intentions. Conflicting observations produce `pending`; existing differing values produce `fails` without overwriting. The product slot is version `0.2.0`: carton fields may be supplied individually, so verified units or weight can be filled before dimensions are known. Core writeback checks source versions and schema on each fill; later fills based on a now-changed version require a fresh read and review. Hosts persist plan results before applying fill intentions. The sample spans two shipping countries, food/nonfood, air freight, own logistics, seller delivery and one denied product, and deliberately produces rate, weight and transit failures. Regenerate it with `node scripts/gen-delivery-example.mjs`; `pnpm examples` checks all seven workflows against committed golden artifacts.

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

`BuildOutInput` carries complete `site: SiteDecision`, `bom: Bom`, and `delivery: DeliveryPlan` envelopes, plus the quote currency, phase and acceptance template IDs. The build-out example consumes synthetic upstream snapshots; the seven packages have independent examples rather than one continuous end-to-end store run. Its upstream listing and BOM-case references are external to this sample asset directory, so `--record` reports partial writeback until their owning slots and records are supplied.

- Map every lease landlord-work item in `landlordScope`; those line IDs are excluded from the contractor quote. `quantities` and `installOverrides` use stable line IDs. Quantities require an operator confirmation.
- Installation rates match by unit, category, kind, jurisdiction, priority and optional name substring. Labor rates, FX, bid minimum, crew size, hours per day, workdays and verification tolerances come from parameters. Missing or ambiguous values block; there are no business defaults.
- Quotes round unit prices before multiplying quantities. Goods use the same two rounding points; labor includes the rounding remainder so goods plus labor equal the charged line totals. Freight comes only from `DeliveryPlan`. `projectClientQuote()` exposes a whitelist of customer fields and material names, excluding source prices, factories, rates and provenance.
- Submit the last accepted artifact as `previousPlan` when revising a quote. Direct edits then require a change order. Each change binds the current quote hash and needs distinct owner and contractor approvals; the contractor approval must identify `input.contractor`. Signed price and calendar-day schedule deltas must match recalculation. Pending changes remain proposed, and rerunning applies each change once from the original quote.
- Each line must map to exactly one phase; split a line if work belongs to multiple phases. Arrival constraints apply per task. Local purchases require explicit `localAvailability` dates. The calendar supports ISO weekdays; holidays and crew resource leveling are outside this version. Checkpoints require evidence before dependent actual work or final acceptance.
- Completion checks distinguish an expected delivery from a receipt, compare installed quantities and site measurements, and create blocking landlord punch items for missing lease delivery. Missing evidence produces an open plan; complete evidence requires a matching owner approval. Accepted and conditional plans carry `acceptedAt`; every open minor punch item needs a due date. The acceptance signature also binds the completion date, checkpoints and quote revision.

The seven step exports are `takeoff`, `estimateHours`, `priceQuote`, `levelBids`, `schedule`, `track`, and `accept`; CLI and MCP discover them from the installed package. Steps only return verification intentions. They never persist changes themselves.

## Opening a store

The synthetic opening example consumes the generated StoreSpec and a separately constructed example Bom reference. It exercises actual written and practical grading for two seats, including course-unit practical checks. Run it after building:

```sh
pnpm osw opening run \
  --assets examples/sample-store/assets \
  --in examples/sample-store/inputs/opening.json \
  --approvals examples/sample-store/approvals/opening.json \
  --now 2026-01-01T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/opening
```

Omit `--approvals` to receive the blocking `opening/signRelease` need. Release approvals use `subject: "store:<storeId>"` and the returned hash of the sorted blockers. `go` requires no blockers; `go_with_conditions` requires only waivable blockers, a note and a dated condition for each one. Applicable gate items cannot be manually skipped. A changed blocker set invalidates a pre-opening signature. Once live, the original signature remains frozen in the previous `OpeningRecord`, while new issues remain visible in `release.current`.

The workflow input accepts explicit `transitions` (for example `["ready", "live"]`), previous records, assessment history, checklist updates and review observations. Supplying `handoff: true` requires an `operating` approval with a note. The result emits an `openedAt` fill intention and preserves an existing first opening date; changing store status belongs to the private adapter. Without a BuildPlan or DeliveryPlan, related checks require manual confirmation. An ETA alone never completes receipt.

Opening adds `role`, `cert`, `course`, `exam`, `track-affinity`, `content-case` and `content-playbook` slots. Four JSON template kinds carry certification, checklist, marketing and content-asset requirements. Business thresholds, budget shares and FX rates come from `params`; qualifier segments use letters and digits. Borrowed course recommendations do not automatically become required certifications: adopted courses must explicitly cover the store's track. Students receive only a projected paper; grading results contain scores and per-question marks, never answer keys. MCP asset queries also honor schema `writeOnly` fields.

Marketing approval and checkpoint review signatures are nonblocking. Marketing output includes budgets, creator selection, evidence gaps and content calendars; only approved categories receive budgets. Reviews calculate ticket and prime-cost figures and produce source-specific verification intentions. The opening example deliberately leaves a content gap and detects an overly easy exam rather than manufacturing all-green results. `pnpm examples` checks all seven workflows and their committed golden artifacts.

## Replenishment

The synthetic store has been operating for a month. Its opening handoff and first-stock BOM seed the recurring list; historical reorders provide cadence and ingredient evidence. The external intake store has no BOM denominator and reports `basis: none`, `byLines: null`.

```sh
pnpm osw replenishment run \
  --assets examples/sample-store/assets \
  --in examples/sample-store/inputs/replenishment.json \
  --approvals examples/sample-store/approvals/replenishment.json \
  --now 2026-02-02T12:00:00Z \
  --actor example:operator \
  --out-dir .osw/supply-program
```

For the reorder path, use `inputs/replenishment-reorder.json` and `approvals/replenishment-reorder.json`. Removing approvals returns exit code `2`. Both modes are read-only: `--record` records asset verifications, while sending mail and saving orders require the explicit `@osw/replenishment/runner` functions. `SupplyProgram.reorders` summarizes persisted orders; proposed orders remain in the step results until a runner writes them.

- The main entry exports 13 steps and six slots, discovered automatically by CLI/MCP. `run` accepts `mode: campaign | reorder`, `rulesetId`, optional paired `opening`/`bom` envelopes, and mode-specific input. Envelope body hashes, store IDs and handoff references are checked.
- Campaign rules are normalized, variants must narrow their topic and have meaningful content differences, and current content requires a hash-bound `send` approval. `sourceRef` derives a stable campaign ID; callers use the returned ID. On subsequent runs pass `previousCampaign` to preserve paused/completed state and the campaign breaker baseline.
- `runCampaignSend` rechecks audience and policy before reserving each send. Reservations precede provider calls; uncertain transmission remains `queued` with a reconciliation need and is never automatically retried. It sends one recipient per message with plain text and signed one-click unsubscribe headers. `MemoryMailProvider` is for tests; `ResendMailProvider` is available from `@osw/replenishment/provider-resend`.
- Each AssetSource represents one sending domain. A complaint can pause all its campaigns. Domain recovery requires an operator `resume` approval for subject `resume-domain`, bound to `domainStatsHash`. Persist the returned `domainBreakerFrom` from the decision step or runner and pass it into subsequent runs. Keep one dispatch executor per domain; a production ledger supporting concurrent dispatch must add atomic global quota reservation.
- Production readers and `SupplyLedger` must share the same persistent send/order state. `reserve` must atomically enforce uniqueness, event/suppression writes must be idempotent, and `putReorder` must compare versions, treating absent `ifVersionHash` as create-if-absent. The supplied memory ledger is an executable reference, not durable storage.
- Use `handleProviderWebhook` to verify the original body and acknowledge replay prevention only after all event and suppression writes succeed. Unknown provider IDs return a blocking retry need. Direct `parseWebhook` consumers must call `ackWebhook` only after successful persistence; a durable `WebhookReplayStore` implements `has` and `claim`. Missing webhook configuration prevents expansion beyond the trial.
- `persistDraftReorders` and `runReorderTransition` perform explicit approved ledger writes. Repeat offers take precedence, quantities are converted before MOQ/tier checks, missing FX returns a need, and fallback last-paid prices require approval. Confirmation requires the supplier or operator; price changes before confirmation need a fresh store approval. Confirmed lines are immutable, and receipt quantities produce verifications.

All business thresholds come from `params`, including send windows, quotas, breakers, matrix sizes, reorder cadence and verification tolerances. Missing inputs never become guessed prices or rates. No production mail, database integration, package publication or deployment is performed by the examples.

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
