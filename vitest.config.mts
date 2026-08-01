import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // DBを使うテストは単一のテスト用インスタンスをTRUNCATEで初期化するため、
    // ファイル並列実行を無効にして相互の初期化が衝突しないようにする。
    fileParallelism: false,
  },
})
