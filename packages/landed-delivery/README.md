# @osw/landed-delivery

Workflow 04 of Open Store Workflows. This package depends on `@osw/core`; it is developed in the shared repository and is independently packageable. npm publication requires separate approval.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm -F @osw/landed-delivery test
```

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

Only manual or signed observations produce fill intentions. Conflicting observations produce `pending`; existing differing values produce `fails` without overwriting. The product slot is version `0.2.0`: carton fields may be supplied individually, so verified units or weight can be filled before dimensions are known. Core writeback checks every fill against its batch-start source version and current target emptiness; multiple fields can be filled in one batch, while a later batch needs a current version. File journal conflicts are surfaced explicitly. Hosts persist plan results before applying fill intentions. The sample spans two shipping countries, food/nonfood, air freight, own logistics, seller delivery and one denied product, and deliberately produces rate, weight and transit failures. Regenerate it with `node scripts/gen-delivery-example.mjs`; `pnpm examples` checks all seven workflows against committed golden artifacts.

License: Apache-2.0.
