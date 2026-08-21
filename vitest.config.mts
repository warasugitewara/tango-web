import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'apps/api/**/*.test.ts',
            'packages/**/*.test.ts',
            'tests/**/*.test.ts',
          ],
          // 統合テストは同じ専用DBをTRUNCATEするため、ファイル間では直列にする。
          fileParallelism: false,
        },
      },
      './apps/web/vitest.config.mts',
    ],
  },
})
