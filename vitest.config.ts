import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20000,
    maxWorkers: 3,
    minWorkers: 1,
  },
});
