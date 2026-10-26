# @osw/core

Shared contracts and data-source adapters for Open Store Workflows. This package is the dependency shared by the seven workflow packages; workflow implementations do not depend on each other.

The source is public under Apache-2.0. npm publication is a separate approval step. Until a package release exists, build it from the repository:

```sh
pnpm install --frozen-lockfile
pnpm -F @osw/core build
pnpm -F @osw/core test
```

The root export provides schemas, canonical hashes, money and unit helpers, `MemorySource`, parameter readers, and workflow contracts. `@osw/core/http` provides `HttpSource`; `@osw/core/node` provides `FileSource`, the CLI and shared runner; `@osw/core/conformance` supplies checks for asset-source implementations. The root and HTTP entry points are portable; local file writes require Unix `flock`.

## Parameter resolution

The runner queries declared parameter families and the `fx` family with bounded pagination. The `keyPrefix` filter uses dot-segment boundaries: `labor.rate` matches that key and `labor.rate.special`, but not `labor.rateExtra`. This is distinct from the jurisdiction `prefix` operator, which uses hyphen-segment boundaries.

Asset services must advertise and implement `params.key` operations `eq`, `in`, and `keyPrefix`. A service missing this capability must reject the query explicitly; the runner must never silently choose a generic price because it failed to retrieve a qualified one. Within the loaded records, qualifier, jurisdiction, track, validity and ambiguity resolution share the same `createParamReader` implementation. `withParameterKeys` and `withFxParams` provide targeted hydration for direct workflow callers and preserve ambiguity and source references.

## Measurements and names

Dimensional comparisons require a unit on the threshold and reading. `meets` returns an input need when the threshold unit is missing, instead of comparing raw values from unrelated units.

`product.name contains` searches every translated string, case-insensitively. Sorting `product.name` uses English when available; otherwise it uses the first language key in deterministic code-unit order. The selected text and asset ID form scalar cursor keys. HTTP adapters must implement the same search and sort projection, rather than comparing the underlying JSON object.

## Fill batches and journals

Every fill in one `applyFills` call is checked against the asset version observed at the start of that call. Distinct empty fields can be filled together; a later fill cannot overwrite a value filled earlier in the batch. A later call with an old version still receives `source_changed`. Every fill is checked against the referenced fieldset and the slot schema.

FileSource persists accepted fills together as one batch and replays through the same guards. The legacy single-fill journal shape remains readable. If a base asset was edited and a prior fill can no longer be replayed, opening the source fails with `journal_conflict`; the failure includes the asset and field, not the private value. A value already materialized into the base asset is accepted as reconciled. Operators must review conflicting values before updating the base asset; reopening never silently drops verified data or overwrites unrelated fields with an old snapshot.
