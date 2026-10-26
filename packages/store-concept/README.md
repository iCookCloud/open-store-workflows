# @osw/store-concept

Workflow 01: define a store concept and produce an approved `StoreSpec` for site search, fitout and opening. The package depends only on `@osw/core` and exports `workflow`, `run`, its six step definitions and its asset-slot schemas.

The source is public under Apache-2.0. npm publication is separately approved; until it is published, use the repository workspace:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm -F @osw/store-concept test
```

## Steps

1. `resolveConcept` selects a calculation template and site profile for the brief.
2. `shortlistMenus` matches menus and applies version-bound approval decisions.
3. `estimate` computes investment, operating costs, revenue, breakeven and payback.
4. `calibrate` compares independent operating-store actuals with the estimate.
5. `deriveSiteRequirements` combines requirements, equipment triggers, area and rent constraints.
6. `assembleSpec` validates the body and requires a matching release approval.

For the runnable synthetic CLI example, see the root [README](../../README.md) and [sample assets](../../examples/sample-store). The same steps are exposed through MCP.

## Financial input rules

- A template with `hasDefaults=false` cannot produce financial output, even when expense overrides are supplied. It returns a blocking need for a trustworthy template; missing investment overrides are listed individually, without forcing monthly percentage costs into fixed amounts.
- A legal budget or monthly override not listed by the template becomes a fixed overridden line. It participates in totals, reserve calculations and budget-cap checks.
- Calibration compares stores on the same jurisdiction prefix chain. It excludes unrelated branches, overridden figures and template-source stores from direct verification.
- A `subtotal_percent` actual is normalized using its source-store ratio and the target normalized subtotal. The source denominator retains template investment categories even when the target amount is overridden to zero. Incomplete denominators produce pending verification, not an invented ratio.
- Only source actuals needed for independent verification or an applicable subtotal request FX. A genuinely required missing rate still blocks.
- Parameter, template, menu and actual-store references retain their source hashes. Final approval binds to the resulting specification body.

业务说明：这是“定店型”包。无可信默认值、缺必要资产／汇率或未获放行时，通过结构化 `needs` 明确停下；不使用占位营收生成回本数字。完整中文运行方式见 [中文 README](../../README.zh-CN.md)。
