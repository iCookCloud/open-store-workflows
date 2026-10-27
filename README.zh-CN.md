# Open Store Workflows

七条开店 workflow 在一个仓库开发，组织为七个独立 npm 包与共享 `@osw/core`。规则、计算和验证由代码提供，资产、价格、合作方和审批记录由使用者接入。

[GitHub 源码](https://github.com/iCookCloud/open-store-workflows) · [自动检查](https://github.com/iCookCloud/open-store-workflows/actions/workflows/ci.yml)

已实现 **共享 core、第 1 项「定店型」、第 2 项「找房」、第 3 项「装修物料单」、第 4 项「到店」、第 5 项「施工」、第 6 项「开门营业」与第 7 项「开业后供货」**，分别生成 `StoreSpec`、`SiteDecision`、`Bom`、`DeliveryPlan`、`BuildPlan`、`OpeningRecord` 和 `SupplyProgram`。七条流程共用 CLI／MCP；生产站点接入另行开展。

npm 发布仍须单独批准；目前从源码工作区安装、构建和运行。

## 包与产出

| 顺序 | 独立包 | 产出 |
| --- | --- | --- |
| 01 | [@osw/store-concept](packages/store-concept/README.md) | `StoreSpec` |
| 02 | [@osw/site-search](packages/site-search/README.md) | `SiteDecision` |
| 03 | [@osw/fitout-bom](packages/fitout-bom/README.md) | `Bom` |
| 04 | [@osw/landed-delivery](packages/landed-delivery/README.md) | `DeliveryPlan` |
| 05 | [@osw/build-out](packages/build-out/README.md) | `BuildPlan` |
| 06 | [@osw/opening](packages/opening/README.md) | `OpeningRecord` |
| 07 | [@osw/replenishment](packages/replenishment/README.md) | `SupplyProgram` |

共享契约见 [@osw/core](packages/core/README.md)，CLI／MCP 使用相同步骤。

## 使用

要求 Node.js 22 及以上，pnpm 版本以 `package.json` 为准。

```sh
corepack enable
git clone https://github.com/iCookCloud/open-store-workflows.git
cd open-store-workflows
pnpm install --frozen-lockfile
pnpm build
```

## CLI／MCP

默认只读资产；只有显式传入 `--record` 才写验证记录和补空意图。执行错误退出 `1`，已有产出但部分写回失败退出 `3`。HTTP 令牌通过环境变量 `OSW_TOKEN` 提供。FileSource 写回使用系统 `flock` 命令协调跨进程并发，读取文件无需它；缺少该命令时写回明确失败，不会降级为无锁覆盖。

```sh
pnpm osw slots --json-schema .osw/schemas
OSW_ASSETS=packages/store-concept/examples/assets node packages/mcp/dist/stdio.js
```

MCP 使用相同步骤和数据格式，查询每页最多 50 条；只有启动时添加 `--allow-record` 才提供写回工具。

## 01 · 定店型

`@osw/store-concept` 完成菜单匹配、投资和保本测算、实账校准、场地要求及放行。详见[定店型包说明](packages/store-concept/README.md)。无可信默认值的模板明确阻断；模板外的合法覆盖科目也计入预算。

```sh
pnpm osw store-concept run \
  --assets packages/store-concept/examples/assets \
  --in packages/store-concept/examples/inputs/store-concept.json \
  --approvals packages/store-concept/examples/approvals/store-concept.json \
  --now 2026-01-01T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/approved
```

删除命令中的 `--approvals` 参数即可观察审批阻断：流程返回待办 `needs`，退出码为 `2`。审批通过后退出码为 `0`，输出目录中包含各步骤结果、`result.json` 和 `artifact.json`。本轮被阻断时 `artifact.json` 写为 `null`，未执行步骤的文件也写为 `null`；复用目录不会把上次成功产物误当成本轮结果。审批绑定所见内容的哈希，内容修改后需要重新批准。

## 02 · 找房

第二项包含筛选、周边扫描、实测、意向书、律师审阅与签署证据核验，详见[找房运行说明](packages/site-search/README.md)。运行 `pnpm examples:site-search` 可验证缺签约批示退出 2、审批完整退出 0。CLI 和 MCP 可用 `--providers <本地模块>` 显式加载外部服务及额度存储。

## 03 · 装修物料单

`@osw/fitout-bom` 已实现案例／识图人审、铺位与菜单用量、用料计价、供应商选择、报价验证、物料单定稿及对外报价。操作方法见 [装修包说明](packages/fitout-bom/README.md)。`packages/fitout-bom/examples` 是从零合成的第三条独立示例，纳入 `pnpm examples` 验收。生产资产中心接入尚需在私有项目实施。

## 04 · 到店

```sh
pnpm osw landed-delivery run \
  --assets packages/landed-delivery/examples/bom/assets \
  --in packages/landed-delivery/examples/bom/inputs/landed-delivery.json \
  --approvals packages/landed-delivery/examples/bom/approvals/landed-delivery.json \
  --now 2026-01-20T12:00:00Z \
  --actor example:delivery-reviewer \
  --out-dir .osw/delivery
```

流程依次执行合规准入、分箱、匹配承运方、补格、定稿、报价、运输更新、签收和汇总，共九个步骤，CLI 与 MCP 共用。首次补格在定稿前完成，保证确认批示覆盖最终格值。输入包含完整 `bom` 信封、`jurisdiction`、可选 `site` / `existing`，以及按箱单 ID 索引的 `carriers`、`edits`、`quotes`、`updates`、`arrivals`。BOM 必须指向资产源中准备开业或营业中的门店。独立调用后续步骤时传入上一步的 `DeliveryState`；`summarize` 返回完整产出物。

- 合规类目继承最多六层；缺分类、断链、循环、跨市场、清单错市场与冲突改写均暂挂。审批只接受 `reviewer` 或带当前律师资产引用的 `lawyer`；必备主体/SKU 证据未解决时不能批准 `enter`。批次材料单独进入箱单。
- 审批哈希排除 `subjectHash` 自身与 `conclusion`，同时绑定证据版本、供应商/进口主体、法域和预计到港有效期；答复变化须重批。六个私有槽位按 core 规范命名为 `compliance-category`、`compliance-item`、`product-classification`、`compliance-answer`、`rate-card`、`packing-history`。
- 按发货国、货类、运输方式分单；卖方配送再按卖方分开。本地走陆运、跨境急件走空运。货代的出发地、目的地和方式必须在同一条 lane 匹配；冷链、尾板车和小车要求进入能力筛选。供应商和运价均由资产提供。
- 件数接受 `pcs` / `set` / `pack`，按 `carton` 计数必须有箱规；重量、体积不能直接换件数。申报币种、汇率和容差没有业务默认值，跨币种汇率为 `1` 仍视为未核验。
- 装卸通道实测值 `dock`、`loading_dock` 或「有装卸平台」表示有平台；未知时返回待办并请求尾板车服务。缺箱单字段提示补充但不阻断定稿；毛重小于净重等矛盾会阻断。
- host 负责认证 `edits[].role`。货代/自带物流只能补允许的空格；品名、规格、货值由操作员修改。定稿后修改须说明原因并留 `amendments`。分享给承运方时用 `viewFor`，隐藏其他报价和内部备注。MCP 面向已授权操作员，不承担分享链接鉴权。
- 货代、定稿、选报价由 `operator` 批准，`client` 接受报价只留痕。无报价时返回带询价待办的计划；已有报价须明确选择，过期报价不可选。运价基数支持 `shipment` / `m3` / `kg` / `carton`；三个 `*Pct` 容差是小数比例，时效容差是天数。
- 承运方报送达不等于门店实收；缺任一必需批次日期时，汇总日期仍为未知。混合预计与实收日期时，汇总采用较弱的证据类型。暂挂、短收、破损都使 `allReceived=false`。恢复既有计划时只传新增运输事件，签收记录不能静默覆盖。
- 回填只认人工/签收实测；同字段多人值冲突记 `pending`，已有值不一致记 `fails`，不覆盖源数据。产品槽位升级到 `0.2.0`，允许逐项提供箱规，已核装箱数和毛重可先于尺寸入库。core 按批次起始版本检查各条意图，同批可补多个空字段；跨批旧版本仍需重新读取。每格仍受 schema 与只补空约束，日志重放冲突会显式报错。host 应先保存计划，再执行补空意图。

示例全部从虚构常数构造，包含两个发货国、食品与非食品、急件空运、自带物流、本地卖方配送和一件拒绝准入的产品，并故意制造运价、重量和时效偏差。合规条目也是虚构示例。运行 `pnpm --filter @osw/landed-delivery examples:generate` 更新该示例；`pnpm examples` 检查七个 workflow。

## 05 · 施工

```sh
pnpm osw build-out run \
  --assets packages/build-out/examples/assets \
  --in packages/build-out/examples/inputs/build-out.json \
  --approvals packages/build-out/examples/approvals/build-out.json \
  --now 2026-01-30T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/build-out
```

输入 `BuildOutInput` 包含完整的 `site: SiteDecision`、`bom: Bom`、`delivery: DeliveryPlan` 信封，以及报价币种、阶段模板和验收模板 ID。示例中的上游产物是从零构造的快照，尚未宣称七项全链路完成；房源和 BOM 案例的来源记录属于上游槽位，本示例目录未附这些记录，补齐其所属槽位与记录前使用 `--record` 会报告部分写回失败。

- **工程量**：`landlordScope` 必须逐项映射租约中的房东施工；对应行移出本方报价。数量调整与工时覆盖按稳定行 ID 输入，工程量确认绑定内容哈希。
- **报价**：人工、汇率、最低比价数、班组人数、每日工时、工作日和验证容差都从参数读取。单价先舍入，再乘数量；产品价也采用这两个舍入点，人工合计吸收舍入余差，确保产品与人工合计等于实际行额。运费直接引用到店产物。`projectClientQuote()` 只给客户字段白名单，不暴露原价、来源、工厂加工成本和费率。
- **变更**：修改已接受报价时传入 `previousPlan`；直接修改会要求变更单。变更绑定当前报价版本，需不同签字人的业主、施工方双签，施工方批示还须匹配 `input.contractor`。价差与日历日工期差必须等于重算结果；单签保持 `proposed`，从原报价重跑不会重复加量。
- **排期**：每行只映射一个阶段，跨阶段工作需拆行；按各任务所需到货日和交房日排期。本地采购显式填写 `localAvailability`。支持 ISO 星期工作日，不处理节假日和多班组资源平衡；阶段检查需有证据，才能登记依赖任务的实耗或完成验收。
- **验收**：ETA 不算收货，逐行核对实装、数量与破损，并复测场地条件。房东未交付会生成阻塞尾项。证据不足时输出 `open`；证据完整时须业主批准当前版本。`accepted`／`conditional` 带 `acceptedAt`，未关闭的轻微尾项必须有到期日。签名还绑定完工日期、阶段检查证据和报价版本。

七个步骤为 `takeoff`、`estimateHours`、`priceQuote`、`levelBids`、`schedule`、`track`、`accept`，CLI／MCP 自动发现。步骤只返回验证意图，写回仍由 runner 显式执行。

## 06 · 开门营业

```sh
pnpm osw opening run \
  --assets packages/opening/examples/assets \
  --in packages/opening/examples/inputs/opening.json \
  --approvals packages/opening/examples/approvals/opening.json \
  --now 2026-01-01T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/opening
```

示例消费第一项生成的 `StoreSpec`，以及单独构造的合成 `Bom` 引用；对两个座位实际执行笔试、实操和课程单元考核。省略 `--approvals` 会返回 `opening/signRelease` 审批待办，退出码为 `2`。

放行审批的 `subject` 为 `store:<storeId>`，`subjectHash` 绑定排序后的阻断集合。`go` 要求无阻断；`go_with_conditions` 只接受可豁免项，每项均需条件、截止日期及签署说明。适用的必过项不能手工跳过，P0、锁定证未过、无人在册和编制缺口不可豁免。开业前阻断变化必须重签；进入 `live` 后沿用上一版 `OpeningRecord` 的原始签署，新问题仍在 `release.current` 展示。

输入中的 `transitions` 明确指定状态流转，例如 `["ready", "live"]`；还可提供上一版记录、考次历史、清单更新及复盘数据。设置 `handoff: true` 后，需附说明的 `operating` 审批。流程只产生 `openedAt` 补空意图，并保留已存在的首次开业日期；门店状态由私有适配层根据 `handoff` 更新。缺少施工或到店产物时对应项人工确认，预计到货日期不能自动算作签收。

新增七个槽位：`role`、`cert`、`course`、`exam`、`track-affinity`、`content-case`、`content-playbook`，以及认证、清单、营销、素材需求四种 JSON 模板。业务阈值、预算比例及汇率均取自 `params`；参数 qualifier 段使用英文字母和数字。借用课程只作推荐，采用后须由资产数据明确覆盖本店赛道才会列为必考。

学生卷、判分输出和 MCP 通用查询均保护答案、解析和评分指南。营销及复盘签署不阻止开业审批；营销只对批准的类别计预算，输出达人筛选、凭证缺口及内容日历。复盘按课程单元、清单项和上游测算来源产生验证记录。示例刻意保留素材缺口，并检出缺少区分度的考卷；`pnpm examples` 核对七条流程及黄金产物。

## 07 · 开业后供货

`@osw/replenishment` 提供 13 个步骤、6 个资产槽位，由 CLI/MCP 自动发现。它接收已放行的 `OpeningRecord` 与首批 `Bom`，检查正文哈希和所属门店，完成分群、供应商匹配、邮件矩阵与发送决策、复购单和上游验证。合成示例中的 Example Noodle Bar 已在营一个月；外部收录店没有 BOM 时，占比保持 `basis: none`、`byLines: null`。

```sh
pnpm osw replenishment run \
  --assets packages/replenishment/examples/assets \
  --in packages/replenishment/examples/inputs/replenishment.json \
  --approvals packages/replenishment/examples/approvals/replenishment.json \
  --now 2026-02-02T12:00:00Z \
  --actor example:operator \
  --out-dir .osw/supply-program
```

复购模式把输入和审批文件名换成 `replenishment-reorder.json`。不提供审批时退出 `2`。运行结果包含每步输出与 `SupplyProgram`；摘要只统计已保存的复购单，待提交的新单保留在步骤结果中。`--record` 只登记验证，邮件发送和订单保存由显式调用 `@osw/replenishment/runner` 完成。

- 邮件内容、规则和正文版本绑定审批；同源 `sourceRef` 派生稳定 campaign ID，调用方应使用返回的 ID。再次运行时传 `previousCampaign`，保留暂停、完成状态和熔断基线。
- `runCampaignSend` 重新检查受众和额度，先占位 `queued` 再逐封发送；网络结果不明时保留占位并返回核对待办，不自动重发。消息包含纯文本与 HMAC 签名的一键退订。真实 Resend 适配器由 `@osw/replenishment/provider-resend` 导出。
- 一个 AssetSource 对应一个发信域。投诉可暂停该域全部批次；恢复需 operator 对 `resume-domain` 的 `domainStatsHash` 批准 `resume`。保存决策步骤或执行器返回的 `domainBreakerFrom`，下次传回。每域使用一个发送执行器；并发生产接入需要台账提供原子的全域额度预留。
- 生产 `SupplyLedger` 与资产读口必须读取同一份持久台账；占位唯一约束、事件和抑制写入幂等、复购版本比较由台账保证。`ifVersionHash` 缺省只允许新建。Memory 实现用于测试与示例。
- `handleProviderWebhook` 验证原始正文，全部事件和抑制记录写成功后才确认去重；未知服务商消息 ID 阻断并等待重试。直接使用 `parseWebhook` 时，持久化成功后才可 `ackWebhook`；持久去重接口实现 `has` 与 `claim`。未配置回调密钥时不超过试水量。
- `persistDraftReorders`、`runReorderTransition` 负责显式保存。先用复购报价并校验单位、阶梯与 MOQ；缺汇率返回待办，沿用上次成交价需要审批。确认前协商改价要求门店重新批准，确认后锁价；收货差异会生成验证记录。

发送窗口、额度、熔断、补货周期和验证阈值均来自 `params`，不猜价格和汇率。示例不发送真实邮件，不接生产数据库。

## 设计约束

- `@osw/core` 统一数据格式、哈希、单位、金额、参数解析和资产接口；所有 workflow 包只依赖它。
- Memory、File、HTTP 三种资产源使用同一份接口。FileSource 支持 JSON、NDJSON 和 CSV。
- 缺业务参数或同级候选不唯一时明确返回 `needs`，不猜默认价格和汇率。
- 金额按币种最小单位逐行舍入，用户覆盖值已经是目标币种，不重复换算。
- 验证排除模板来源门店的同源自证，也不把用户覆盖值记成模板错误。
- 步骤只读资产。人工批示、版本变化和只补空规则在实际运行时校验。
- 核心模块和 workflow 可打包到非 Node 环境，文件与命令行适配集中在 `@osw/core/node`。
- 参数族通过点分段的 `keyPrefix` 下推查询，能取回 qualifier；维度门槛缺单位返回待办；补空日志冲突明确报错。具体协议见 [core 说明](packages/core/README.md)。

## 验收与示例

每条 workflow 自带 `packages/<workflow>/examples/`、包内生成／检查脚本和专属 MCP 测试。进入任意 workflow 包目录后可执行：

```sh
pnpm test
pnpm examples
pnpm examples:generate
```

根目录 `pnpm examples` 按 01–07 依次调用各包检查，`pnpm examples:generate` 依次运行独立生成器。跨 workflow 只使用消费包 `examples/upstream/` 中冻结的 core 产出物 JSON；采用新版上游产物时显式更新输入快照，不导入另一条 workflow 的脚本。通用文件／CLI 验收工具位于 `@osw/core/node`，通用 MCP 连接工具位于 `@osw/mcp/testing`。

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm boundaries
pnpm runtime
pnpm examples
```

示例店 **Example Noodle Bar** 使用虚构法域 `XE`、从零构造的数值和固定随机种子。`pnpm examples` 会在独立临时目录重新生成数据，比对仓库中的预期结果，并验证无审批阻断、批准后完成和至少一条真实判为 `fails` 的偏差记录。需要更新示例时运行 `pnpm examples:generate`，并审查差异。

私有数据扫描必须提供仓库外的非空黑名单文件：每行一个字面词，或使用 `re:` 开头的正则。匹配会进行 Unicode 规范化、大小写归一与去空白，同时检查凭据、绝对路径、电话、邮箱和域名。

```sh
export OSW_PRIVATE_DENYLIST=/secure/workflow-denylist.txt
pnpm scan
node scripts/scan-private.mjs --history
git config core.hooksPath .githooks
```

未配置黑名单时扫描失败。`pre-push` 检查待推提交；GitHub Actions 为推送和 PR 运行构建、测试与示例。主分支隐私检查使用 `OSW_PRIVATE_DENYLIST_CONTENT` 仓库 secret 扫描完整历史，私有词表不会提供给 PR 作业。可选的 Woodpecker 使用 `osw_private_denylist` secret。发布包还可以用 `--tarball` 检查。GitHub 源码公开与 npm 发布、生产接入分别管理。

## 许可证

许可证：[Apache-2.0](LICENSE)。
