# Development

- Keep workflow steps deterministic and read-only; only runners may write.
- Workflow packages depend only on @osw/core. Import schemas through core; no copied contracts.
- Use Chinese comments and English identifiers. Tests belong in package tests/ directories.
- Synthetic examples must be built from invented constants; private data and credentials never enter Git.
- No file deletion, public release, or production changes without explicit approval.
- Run lint, typecheck, tests, boundaries, runtime, examples and private scan before delivery.
