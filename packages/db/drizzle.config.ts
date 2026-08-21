import { readFileSync } from 'node:fs'
import { defineConfig } from 'drizzle-kit'

/**
 * 接続URLは検証済みの環境変数からのみ受け取る。
 * `db:generate` は接続不要なので、未設定でも生成だけは行えるようにする。
 */
const databaseUrlFile = process.env.DATABASE_URL_FILE
const databaseUrl =
  process.env.DATABASE_URL ??
  (databaseUrlFile === undefined
    ? ''
    : readFileSync(databaseUrlFile, 'utf8').trim())

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
})
