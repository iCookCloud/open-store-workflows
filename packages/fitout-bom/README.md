# @osw/fitout-bom

将案例或参考图转成可追溯的装修物料单。模型成本、供应商报价、最终选用单价分别保留，构件用量不会被采购报价覆盖。只读资产源；验证记录由 CLI/MCP runner 按明确的写入选项保存。

## 运行合成示例

在仓库根目录执行：

```bash
pnpm install
pnpm build
pnpm osw fitout-bom run \
  --assets examples/fitout-store/assets \
  --in examples/fitout-store/inputs/fitout-bom.json \
  --approvals examples/fitout-store/approvals/fitout-bom.json \
  --now 2026-01-01T12:00:00Z \
  --out-dir .osw/fitout
```

不提供 `--approvals` 时，流程在供应商选择处返回退出码 2，并给出所需批示的 `step`、`subject`、`subjectHash`。`decision` 为报价 ID 或 `none`；定稿及识图人审使用 `approve`；场地条件例外使用 `waive`。修改所批内容后必须重新确认。示例批示只适用于合成数据。加 `--record` 才向资产源保存验证。

示例从零构造，含一个案例、一份材质单价、三个供应商报价及配套 `StoreSpec`、`SiteDecision`。预期模型成本和选用成本均为 USD 200，三个报价分别产生 `holds`、`fails`、`pending`。它独立验证第三条 workflow；全七条串联不属于本包的验收。

## 步骤

| Step | 行为 |
| --- | --- |
| seedFromCase | 案例重编号并重映射关联数量，清空原采购选择 |
| identifyItems | 导入候选 JSON/CSV，或调用注入的 itemizer；校验来源、缓存、限额 |
| reviewItems | 接受、编辑、合并、拆分、拒绝；人工批示绑定候选、决定与生成行 |
| scaleToSite | 按铺位计算数量并检查电力、燃气、排烟及净高 |
| deriveMenuLines | 配方毛料量 × 日销量 × 首批覆盖天数；件装取整；设备台数须人核 |
| resolveProducts | 唯一在售同名品自动关联；多候选需选择；缺品需建档 |
| priceModel | 按构件、几何量及材质单价计算模型成本 |
| sourceLines | 批量读取有效报价、按单位和汇率比较，经确认后选供应商 |
| verifyOffers | 验证全部候选报价、主材费率及产品尺寸 |
| freezeBom | 重查来源版本、场地、模型与供应商批示，再生成不可变 `Bom` |
| quoteBom | 使用注入费率计算对外报价，允许人工最终单价 |

所有步骤使用同一组 `StepDef`，CLI 和 MCP 自动发现。直接调用的入口均由主模块导出；JSON Schema 可由 `z.toJSONSchema(step.input)` 与各槽位生成。

## 数据与参数

包内槽位为 `design`、`material-rate`、`line-template`、`bom-case`，版本均为 `0.1.0`，遵守 core 的小写连字符命名。`BomBody`、`BomLine`、`Component`、`QtyRule` 在 core 中共享。

`waste`、`lossPct` 及费率使用小数比例，`0.1` 表示 10%。几何生成器把用量、一次损耗及人工固化为可编辑构件；模型复算直接使用这些构件，避免重复计损耗。更换尺寸后须重新生成构件。

没有内置业务单价或费率。`bom.offerBand.low/high` 和 `bom.specTolerance` 支持按 `lineKind` 限定，尺寸容差单位为 mm；`bom.rateCheckMinOffers` 是独立已选报价数量。`fx.<FROM>.<TO>` 按实际资产币种批量读取，不推断倒数汇率。铺位缩放把法域与赛道带入 draft 的 `context`，并按该范围解析参数。读到的价格参数版本进入来源记录。

缺单价、缺汇率或单位不兼容时，模型成本为 `null`，不能用零成本通过定稿。含运输、安装或税的报价，及仅有估价依据的整件模型，报价比较为 `pending`。不可比较不等于报价不合格。

## 图像输入与人工确认

`identifyItems` 的输入可直接包含 `candidates`（数组、JSON 字符串或 CSV 文本）。CSV 嵌套列 `dimensionsMm`、`componentsHint`、`evidence`、`estimated` 使用 JSON。也可在代码中注入 `importedItemizer`。远程适配器为可选子入口：

```ts
import { openaiCompatibleItemizer } from '@osw/fitout-bom/providers/openai-compatible';
```

构造参数必须显式提供 `fetch`、`baseUrl`、`model`、`apiKey` 和 `quota`。调用时必须有原子 `QuotaStore`；缓存键包含图像、区域、提示词版本、模型及导入内容。远程候选按区域分批，每批最多 500 行，整单最多 2000 行。仅由生成图支持的行始终标记尺寸和数量为估算。

`reviewItems.decisions` 每条含 `action`、`candidateIds`、`outputs`。输出行的 `key` 用于维持合并和拆分后的稳定 ID；`candidate` 给出复核后的候选，`templateId` 指向构件模板。批示绑定全部候选、决定和最终清单。

## 验证与边界

```bash
pnpm exec vitest run packages/fitout-bom/tests
pnpm exec tsx scripts/gen-fitout-example.ts
pnpm examples
```

不发送询价、不写产品档案、不生成效果图、不代替现场实测。缺货返回 `rfq`，定制品缺档返回 `createProduct`。配方产量须为份数（`pcs`/`set`）；不能把 `carton.units` 件数直接当 kg/L 的包装规格。

生产资产中心的槽位投影、采购结果写回和站点页面替换需在私有项目中另行接入。本包未修改生产数据，也未发布 npm 包。
