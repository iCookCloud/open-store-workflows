# Open Store Workflows

把开店流程中的规则、计算和验证封装成可复用的包，由使用者接入自己的资产、价格、合作方和审批记录。

[GitHub 源码](https://github.com/iCookCloud/open-store-workflows) · [自动检查](https://github.com/iCookCloud/open-store-workflows/actions/workflows/ci.yml)

已实现 **共享 core、第 1 项「定店型」、第 2 项「找房」、第 3 项「装修物料单」与第 7 项「开业后供货」**，分别生成 `StoreSpec`、`SiteDecision`、`Bom` 和 `SupplyProgram`。四条流程共用 CLI／MCP；其余三项及生产站点接入另行开展。

第二项包含筛选、周边扫描、实测、意向书、律师审阅与签署证据核验，详见[找房运行说明](packages/site-search/README.md)。运行 `pnpm examples:site-search` 可验证缺签约批示退出 2、审批完整退出 0。CLI 和 MCP 可用 `--providers <本地模块>` 显式加载外部服务及额度存储。

## 使用

要求 Node.js 22 及以上，pnpm 版本以 `package.json` 为准。

```sh
corepack enable
git clone https://github.com/iCookCloud/open-store-workflows.git
cd open-store-workflows
pnpm install --frozen-lockfile
pnpm build
pnpm osw store-concept run \
  --assets examples/sample-store/assets \
  --in examples/sample-store/inputs/store-concept.json \
  --approvals examples/sample-store/approvals/store-concept.json \
  --now 2026-01-01T00:00:00Z \
  --actor example:reviewer \
  --out-dir .osw/approved
```

删除命令中的 `--approvals` 参数即可观察审批阻断：流程返回待办 `needs`，退出码为 `2`。审批通过后退出码为 `0`，输出目录中包含各步骤结果、`result.json` 和 `artifact.json`。本轮被阻断时 `artifact.json` 写为 `null`，未执行步骤的文件也写为 `null`；复用目录不会把上次成功产物误当成本轮结果。审批绑定所见内容的哈希，内容修改后需要重新批准。

默认只读资产；只有显式传入 `--record` 才写验证记录和补空意图。执行错误退出 `1`，已有产出但部分写回失败退出 `3`。HTTP 令牌通过环境变量 `OSW_TOKEN` 提供。FileSource 写回使用系统 `flock` 命令协调跨进程并发，读取文件无需它；缺少该命令时写回明确失败，不会降级为无锁覆盖。

```sh
pnpm osw slots --json-schema .osw/schemas
OSW_ASSETS=examples/sample-store/assets node packages/mcp/dist/stdio.js
```

MCP 使用相同步骤和数据格式，查询每页最多 50 条；只有启动时添加 `--allow-record` 才提供写回工具。

## 开业后供货

`@osw/replenishment` 提供 13 个步骤、6 个资产槽位，由 CLI/MCP 自动发现。它接收已放行的 `OpeningRecord` 与首批 `Bom`，检查正文哈希和所属门店，完成分群、供应商匹配、邮件矩阵与发送决策、复购单和上游验证。合成示例中的 Example Noodle Bar 已在营一个月；外部收录店没有 BOM 时，占比保持 `basis: none`、`byLines: null`。

```sh
pnpm osw replenishment run \
  --assets examples/sample-store/assets \
  --in examples/sample-store/inputs/replenishment.json \
  --approvals examples/sample-store/approvals/replenishment.json \
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

- `@osw/core` 统一数据格式、哈希、单位、金额、参数解析和资产接口；`@osw/store-concept` 只依赖它。
- Memory、File、HTTP 三种资产源使用同一份接口。FileSource 支持 JSON、NDJSON 和 CSV。
- 缺业务参数或同级候选不唯一时明确返回 `needs`，不猜默认价格和汇率。
- 金额按币种最小单位逐行舍入，用户覆盖值已经是目标币种，不重复换算。
- 验证排除模板来源门店的同源自证，也不把用户覆盖值记成模板错误。
- 步骤只读资产。人工批示、版本变化和只补空规则在实际运行时校验。
- 核心模块和 workflow 可打包到非 Node 环境，文件与命令行适配集中在 `@osw/core/node`。

## 验收与示例

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm boundaries
pnpm runtime
pnpm examples
```

示例店 **Example Noodle Bar** 使用虚构法域 `XE`、从零构造的数值和固定随机种子。`pnpm examples` 会在独立临时目录重新生成数据，比对仓库中的预期结果，并验证无审批阻断、批准后完成和至少一条真实判为 `fails` 的偏差记录。需要更新示例时运行 `node scripts/gen-examples.mjs`，并审查差异。

私有数据扫描必须提供仓库外的非空黑名单文件：每行一个字面词，或使用 `re:` 开头的正则。匹配会进行 Unicode 规范化、大小写归一与去空白，同时检查凭据、绝对路径、电话、邮箱和域名。

```sh
export OSW_PRIVATE_DENYLIST=/secure/workflow-denylist.txt
pnpm scan
node scripts/scan-private.mjs --history
git config core.hooksPath .githooks
```

未配置黑名单时扫描失败。`pre-push` 检查待推提交；GitHub Actions 为推送和 PR 运行构建、测试与示例。主分支隐私检查使用 `OSW_PRIVATE_DENYLIST_CONTENT` 仓库 secret 扫描完整历史，私有词表不会提供给 PR 作业。可选的 Woodpecker 使用 `osw_private_denylist` secret。发布包还可以用 `--tarball` 检查。GitHub 源码公开与 npm 发布、生产接入分别管理。

许可证：[Apache-2.0](LICENSE)。

## 第三条：装修物料单

`@osw/fitout-bom` 已实现案例／识图人审、铺位与菜单用量、用料计价、供应商选择、报价验证、物料单定稿及对外报价。操作方法见 [装修包说明](packages/fitout-bom/README.md)。`examples/fitout-store` 是从零合成的第三条独立示例，纳入 `pnpm examples` 验收。生产资产中心接入尚需在私有项目实施。
