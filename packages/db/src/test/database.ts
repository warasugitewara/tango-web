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

/** テストDBとして許可するホスト。ループバック以外は受け付けない。 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
])

/** テストDBとして必須のデータベース名接尾辞。 */
const REQUIRED_DATABASE_SUFFIX = '_test'

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set([
  'postgres:',
  'postgresql:',
])

const TEST_DATABASE_HANDLE_BRAND: unique symbol = Symbol('TestDatabaseHandle')

const RESET_SAFETY_ERROR =
  'テストデータベースの安全性を確認できないため、リセットを中止しました。'

export type TestDatabaseHandle = Readonly<
  DatabaseHandle & {
    readonly [TEST_DATABASE_HANDLE_BRAND]: true
  }
>

/** factoryが返したhandle identityと、検証済みDB名だけを対応付ける。 */
const registeredTestDatabases = new WeakMap<object, string>()

/**
 * 接続先がテスト専用インスタンスであることを確認する。
 * このモジュールは全テーブルをTRUNCATE CASCADEするため、
 * 設定ミスで開発用や本番のデータベースへ向いた瞬間にデータを失う。
 * 破壊的な操作の手前で必ず落とす。
 *
 * エラーメッセージにはホスト名とデータベース名だけを載せ、
 * 接続URLと認証情報は決して含めない。
 */
function validateTestDatabaseUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('TEST_DATABASE_URL をURLとして解釈できません。')
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `TEST_DATABASE_URL はPostgreSQLの接続URLである必要があります: ${url.protocol}`,
    )
  }

  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(
      `TEST_DATABASE_URL のホストがループバックではありません: ${url.hostname}。` +
        ' テストは全テーブルをTRUNCATEするため、テスト専用インスタンス以外へは接続しない。',
    )
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))

  if (!database.endsWith(REQUIRED_DATABASE_SUFFIX)) {
    throw new Error(
      `TEST_DATABASE_URL のデータベース名が "${REQUIRED_DATABASE_SUFFIX}" で終わっていません: ${database || '(未指定)'}。` +
        ' テスト専用のデータベースだけを対象にする。',
    )
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NODE_ENV=production ではテスト用データベースヘルパを実行できません。',
    )
  }

  return database
}

export function assertTestDatabaseUrl(rawUrl: string): void {
  validateTestDatabaseUrl(rawUrl)
}

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
 * 接続する前に、接続先がテスト専用インスタンスであることを必ず確認する。
 */
export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  const expectedDatabaseName = validateTestDatabaseUrl(TEST_DATABASE_URL)

  const databaseHandle = createDatabase(TEST_DATABASE_URL, { max: 5 })

  migrationPromise ??= migrate(databaseHandle.db, {
    migrationsFolder: MIGRATIONS_FOLDER,
  })
  await migrationPromise

  const handle: TestDatabaseHandle = Object.freeze({
    db: databaseHandle.db,
    close: databaseHandle.close,
    [TEST_DATABASE_HANDLE_BRAND]: true,
  })
  registeredTestDatabases.set(handle, expectedDatabaseName)

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
      select id || ' ' || merge_key || ' ' || coalesce(source_guest_token_hash, '') from identity_merges
      union all
      select id || ' ' || event_type || ' ' || metadata::text from audit_logs
    ) as identity_rows
  `)

  return rows[0]?.payload ?? ''
}

/**
 * 識別まわりの全テーブルを空にする。テストごとの独立性を担保する。
 * 破壊的な操作なので、ここでも接続先がテスト専用かを再確認する。
 */
export async function resetIdentityTables(
  handle: TestDatabaseHandle,
): Promise<void> {
  const expectedDatabaseName =
    typeof handle === 'object' && handle !== null
      ? registeredTestDatabases.get(handle)
      : undefined

  if (
    expectedDatabaseName === undefined ||
    handle[TEST_DATABASE_HANDLE_BRAND] !== true ||
    !expectedDatabaseName.endsWith(REQUIRED_DATABASE_SUFFIX)
  ) {
    throw new Error(RESET_SAFETY_ERROR)
  }

  let currentDatabase: string | undefined
  try {
    const rows = await handle.db.execute<{ currentDatabase: string }>(sql`
      select current_database() as "currentDatabase"
    `)
    currentDatabase = rows[0]?.currentDatabase
  } catch {
    throw new Error(RESET_SAFETY_ERROR)
  }

  if (currentDatabase !== expectedDatabaseName) {
    throw new Error(RESET_SAFETY_ERROR)
  }

  const targets = RESETTABLE_TABLES.map((table) => `"${table}"`).join(', ')
  await handle.db.execute(
    sql.raw(`truncate table ${targets} restart identity cascade`),
  )
}
