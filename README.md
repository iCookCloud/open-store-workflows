# Open Store Workflows

Reusable, data-driven workflows for planning and operating a store. Business rules live in code; asset records, prices, partners and approvals come from the operator's own sources.

[简体中文](README.zh-CN.md)

[Source](https://github.com/iCookCloud/open-store-workflows) · [CI](https://github.com/iCookCloud/open-store-workflows/actions/workflows/ci.yml)

Implemented workflows include **store-concept** (`StoreSpec`), **site-search** (screening, surveys, LOI, counsel review and signed `SiteDecision`), **fitout-bom** (reviewed quantities, supplier offers and frozen `Bom`), and **replenishment** (campaign and reorder decisions with `SupplyProgram`). They share the core, CLI and MCP interfaces. The remaining three workflows and production-system integration are separate work.

See the [site-search guide](packages/site-search/README.md) for the synthetic end-to-end example and explicit local `--providers` modules. `pnpm examples:site-search` checks missing-signature-approval exit 2 and completed exit 0.

## Packages

| Package | Responsibility |
| --- | --- |
| `@osw/core` | Schemas, hashing, units, money, conditions, parameter resolution, asset sources and artifact contracts |
| `@osw/store-concept` | Concept selection, menus, investment and breakeven calculations, calibration, site requirements and release approval |
| `@osw/replenishment` | Operating-store segments, supplier matching, newsletter decisions, reorders and upstream verification |
| `@osw/site-search` | Unit-aware listing filters, independent surveys, lease drift, approvals and signing evidence |
| `@osw/fitout-bom` | Case/image review, quantities, model costs, supplier offers, verification and BOM release approval |
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

## Fitout workflow

`@osw/fitout-bom` implements case/image review, site and menu quantities, material costing, supplier selection, offer verification, BOM freezing and optional customer quotes. See [the fitout package guide](packages/fitout-bom/README.md). The fully synthetic `examples/fitout-store` fixture is checked by `pnpm examples`.
