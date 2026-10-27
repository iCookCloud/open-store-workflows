# @osw/replenishment

Workflow 07 of Open Store Workflows. This package depends on `@osw/core`; it is developed in the shared repository and is independently packageable. npm publication requires separate approval.

From this package directory after installing and building the workspace:

```sh
pnpm test
pnpm examples
pnpm examples:generate
```

The synthetic store has been operating for a month. Its opening handoff and first-stock BOM seed the recurring list; historical reorders provide cadence and ingredient evidence. The external intake store has no BOM denominator and reports `basis: none`, `byLines: null`.

```sh
pnpm exec osw replenishment run \
  --assets examples/assets \
  --in examples/inputs/replenishment.json \
  --approvals examples/approvals/replenishment.json \
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

## Package-owned examples

The `examples/` tree, `scripts/generate-examples.mjs`, and `scripts/check-examples.mjs` belong to this package. Generation does not import another workflow or write a shared repository fixture. Frozen upstream contracts live in `examples/upstream/`; replace those JSON envelopes intentionally when testing a different handoff. The checker regenerates into a temporary directory, compares the complete tree, then runs the real CLI with and without approval.

`examples/seeds/unclassified-stores.json` preserves three deliberately unclassified synthetic stores alongside the two supply stores, so segmentation and private-data assertions remain exercised. The expected send ledger uses the memory provider only.

License: Apache-2.0.
