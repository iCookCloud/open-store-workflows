# @osw/opening

Workflow 06 of Open Store Workflows. This package depends on `@osw/core`; it is developed in the shared repository and is independently packageable. npm publication requires separate approval.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm -F @osw/opening test
```

The synthetic opening example consumes frozen core StoreSpec and Bom JSON handoffs. It exercises actual written and practical grading for two seats, including course-unit practical checks. From this package directory after the workspace build:

```sh
pnpm examples
```

The package check runs without approvals to verify the blocking `opening/signRelease` need, then runs with the frozen approval file to verify release. Release approvals use `subject: "store:<storeId>"` and the returned hash of the sorted blockers. `go` requires no blockers; `go_with_conditions` requires only waivable blockers, a note and a dated condition for each one. Applicable gate items cannot be manually skipped. A changed blocker set invalidates a pre-opening signature. Once live, the original signature remains frozen in the previous `OpeningRecord`, while new issues remain visible in `release.current`.

The workflow input accepts explicit `transitions` (for example `["ready", "live"]`), previous records, assessment history, checklist updates and review observations. Supplying `handoff: true` requires an `operating` approval with a note. The result emits an `openedAt` fill intention and preserves an existing first opening date; changing store status belongs to the private adapter. Without a BuildPlan or DeliveryPlan, related checks require manual confirmation. An ETA alone never completes receipt.

Opening adds `role`, `cert`, `course`, `exam`, `track-affinity`, `content-case` and `content-playbook` slots. Four JSON template kinds carry certification, checklist, marketing and content-asset requirements. Business thresholds, budget shares and FX rates come from `params`; qualifier segments use letters and digits. Borrowed course recommendations do not automatically become required certifications: adopted courses must explicitly cover the store's track. Students receive only a projected paper; grading results contain scores and per-question marks, never answer keys. MCP asset queries also honor schema `writeOnly` fields.

Marketing approval and checkpoint review signatures are nonblocking. Marketing output includes budgets, creator selection, evidence gaps and content calendars; only approved categories receive budgets. Reviews calculate ticket and prime-cost figures and produce source-specific verification intentions. The opening example deliberately leaves a content gap and detects an overly easy exam rather than manufacturing all-green results. `pnpm examples` checks this package’s workflow and committed golden artifact.

License: Apache-2.0.

## Package-owned example

From this package directory:

```sh
pnpm test
pnpm examples
pnpm examples:generate
```

`examples/` owns this workflow's assets, inputs, approvals and golden `OpeningRecord`. `examples/upstream/store-spec.json` and `bom.json` are frozen core artifact handoffs; update them deliberately when adopting a new upstream example. No generator or test imports another workflow's script. `source-assets.json` is the matching synthetic read-source snapshot used for version-guarded upstream verification, not a dependency on the producer's schema or implementation.

The check runs the ordinary file-backed CLI without approvals (exit 2) and with approvals (exit 0), then uses an explicit `MemorySource` to exercise `--record`, asserting actual verifications, a failing verdict and the `openedAt` fill. FileSource alone only loads known local slots; recording verification against an upstream-only slot such as `calc-template` needs its owning asset service or a host-injected source with those records. A real HTTP asset service can accept that source reference without importing the upstream workflow.

`pnpm examples:generate` updates only this package's fixture tree. The committed snapshots are synthetic and contain no production data.
