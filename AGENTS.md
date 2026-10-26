# Development

- Keep workflow steps deterministic and read-only; only runners may write.
- Workflow packages depend only on @osw/core. Import schemas through core; no copied contracts.
- Use Chinese comments and English identifiers. Tests belong in package tests/ directories.
- Synthetic examples must be built from invented constants; private data and credentials never enter Git.
- 公开到 GitHub 已获用户授权；删除文件、生产改动、npm 发布仍需批准。
- Run lint, typecheck, tests, boundaries, runtime, examples and private scan before delivery.

- 仓库先不拆：一个仓库，对外提供七个独立 npm 包与 `@osw/core`；npm 发布仍单独审批。
- `@osw/core` 由当前 core 负责人统一修改；其他 workflow 提交接口需求，不自行修改 core。
