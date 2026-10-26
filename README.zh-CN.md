# Open Store Workflows

把开店流程中的规则、计算和验证封装成可复用的包，由使用者接入自己的资产、价格、合作方和审批记录。

本批实现 **共享 core 与第 1 项「定店型」**：从开店意图出发，匹配测算模板与菜单，计算投资、营收、保本、回本和场地要求，经审批后生成 `StoreSpec`。其余六项流程的业务实现与现有站点对接另行开展。

## 使用

要求 Node.js 22 及以上，pnpm 版本以 `package.json` 为准。

```sh
corepack enable
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

未配置黑名单时扫描失败。`pre-push` 检查待推提交，Woodpecker 使用 `osw_private_denylist` secret。发布包还可以用 `--tarball` 检查。当前不自动发布 npm、不转公开、不修改生产站点。

许可证：[Apache-2.0](LICENSE)。
