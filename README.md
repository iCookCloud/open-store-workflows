# Open Store Workflows

Reusable, data-driven workflows for planning and operating a store. Business rules live in code; asset records, prices, partners and approvals come from the operator's own sources.

[简体中文](README.zh-CN.md)

[Source](https://github.com/iCookCloud/open-store-workflows) · [CI](https://github.com/iCookCloud/open-store-workflows/actions/workflows/ci.yml)

Implemented workflows include **store-concept** (`StoreSpec`), **site-search** (`SiteDecision`), **fitout-bom** (`Bom`), **landed-delivery** (`DeliveryPlan`), and **opening** (`OpeningRecord`). They share the core, CLI and MCP interfaces. The remaining two workflows and production-system integration are separate work.

See the [site-search guide](packages/site-search/README.md) for the synthetic end-to-end example and explicit local `--providers` modules. `pnpm examples:site-search` checks missing-signature-approval exit 2 and completed exit 0.

## Packages

| Package | Responsibility |
| --- | --- |
| `@osw/core` | Schemas, hashing, units, money, conditions, parameter resolution, asset sources and artifact contracts |
| `@osw/store-concept` | Concept selection, menus, investment and breakeven calculations, calibration, site requirements and release approval |
| `@osw/site-search` | Unit-aware listing filters, independent surveys, lease drift, approvals and signing evidence |
| `@osw/fitout-bom` | Case/image review, quantities, model costs, supplier offers, verification and BOM release approval |
| `@osw/landed-delivery` | Compliance review, packing, carrier capabilities, freight quotations, shipment tracking and measured receipts |
| `@osw/opening` | Staffing, SOP coverage, assessments, checklists, release signatures, marketing, reviews and operating-store handoff |
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

Marketing approval and checkpoint review signatures are nonblocking. Marketing output includes budgets, creator selection, evidence gaps and content calendars; only approved categories receive budgets. Reviews calculate ticket and prime-cost figures and produce source-specific verification intentions. The opening example deliberately leaves a content gap and detects an overly easy exam rather than manufacturing all-green results. `pnpm examples` checks all five workflows and their committed golden artifacts.

## Semantics that matter

- Missing or ambiguous business parameters produce structured `needs`. There are no fallback business prices, exchange rates or operating assumptions in code.
- Approval binds to the hash of the approved content. Changing a menu or final specification requires a fresh matching approval.
- Steps read assets and return verification and fill intentions. The runner performs explicitly requested writes.
- Asset hashes supplied by a source are authoritative, including when fields have been redacted. Incompatible slot major versions fail explicitly.
- Monetary amounts are rounded by currency at line level. Overrides are already in the requested output currency.
- Calibration excludes a template's own source stores and does not verify a user override against the template.
- The source protocol uses bounded filtering and cursor pagination. Unknown fields and unsupported operations are rejected.

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

Only manual or signed observations produce fill intentions. Conflicting observations produce `pending`; existing differing values produce `fails` without overwriting. The product slot is version `0.2.0`: carton fields may be supplied individually, so verified units or weight can be filled before dimensions are known. Core writeback checks source versions and schema on each fill; later fills based on a now-changed version require a fresh read and review. Hosts persist plan results before applying fill intentions. The sample spans two shipping countries, food/nonfood, air freight, own logistics, seller delivery and one denied product, and deliberately produces rate, weight and transit failures. Regenerate it with `node scripts/gen-delivery-example.mjs`; `pnpm examples` checks all five workflows against committed golden artifacts.

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

## Fitout workflow

`@osw/fitout-bom` implements case/image review, site and menu quantities, material costing, supplier selection, offer verification, BOM freezing and optional customer quotes. See [the fitout package guide](packages/fitout-bom/README.md). The fully synthetic `examples/fitout-store` fixture is checked by `pnpm examples`.
