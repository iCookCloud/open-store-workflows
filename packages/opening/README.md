# @osw/opening

Workflow 06 of Open Store Workflows. This package depends on `@osw/core`; it is developed in the shared repository and is independently packageable. npm publication requires separate approval.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm -F @osw/opening test
```

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

License: Apache-2.0.
