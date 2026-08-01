/**
 * 統合テスト用のデータベースヘルパ。
 * `infra/test/compose.yml` が起動するテスト専用インスタンスだけを対象にする。
 * 本番の接続情報・シークレット経路とは一切共有しない。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDatabase, type Database, type DatabaseHandle } from '../client'

/** テスト専用インスタンスの既定接続先。認証情報はテスト用の固定値。 */
const DEFAULT_TEST_DATABASE_URL =
  'postgres://tango_test:tango_test@127.0.0.1:55432/tango_test'

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL

// Bun (bun run) とVitest (Node) の双方で解決できる形で参照する。
const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
)

/** TRUNCATE対象。外部キー順序に依存しないようCASCADEを使う。 */
const RESETTABLE_TABLES = [
  'audit_logs',
  'identity_merges',
  'user_settings',
  'guest_sessions',
  'principals',
  'account',
  'session',
  'verification',
  'user',
] as const

let migrationPromise: Promise<void> | null = null

/**
 * テストDBへ接続し、プロセス内で一度だけマイグレーションを適用する。
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const handle = createDatabase(TEST_DATABASE_URL, { max: 5 })

  migrationPromise ??= migrate(handle.db, {
    migrationsFolder: MIGRATIONS_FOLDER,
  })
  await migrationPromise

  return handle
}

/**
 * 識別まわりのテーブルに入っている文字列を1本に連結して返す。
 * 生のゲストトークンがどこにも保存されていないことを検証するために使う。
 */
export async function dumpIdentityText(db: Database): Promise<string> {
  const rows = await db.execute<{ payload: string }>(sql`
    select coalesce(string_agg(payload, ' '), '') as payload
    from (
      select id || ' ' || coalesce(user_id, '') as payload from principals
      union all
      select id || ' ' || token_hash from guest_sessions
      union all
      select id || ' ' || merge_key from identity_merges
      union all
      select id || ' ' || event_type || ' ' || metadata::text from audit_logs
    ) as identity_rows
  `)

  return rows[0]?.payload ?? ''
}

/**
 * 識別まわりの全テーブルを空にする。テストごとの独立性を担保する。
 */
export async function resetIdentityTables(db: Database): Promise<void> {
  const targets = RESETTABLE_TABLES.map((table) => `"${table}"`).join(', ')
  await db.execute(
    sql.raw(`truncate table ${targets} restart identity cascade`),
  )
}
