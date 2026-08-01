import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/** 製品全体で固定するタイムゾーン。学習日境界 (04:00 JST) の判定と一致させる。 */
export const DATABASE_TIME_ZONE = 'Asia/Tokyo' as const

export type DatabaseSchema = typeof schema

export type Database = PostgresJsDatabase<DatabaseSchema>

export type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0]

export type DatabaseHandle = {
  readonly db: Database
  readonly close: () => Promise<void>
}

export type CreateDatabaseOptions = {
  /** プールの最大接続数。テストでは小さくして接続枯渇を避ける。 */
  readonly max?: number
}

/**
 * 接続URLからDrizzleクライアントを作る。
 * 接続URLは呼び出し側が検証済みの環境変数から渡す。ここでは決してログに出さない。
 */
export function createDatabase(
  connectionUrl: string,
  options: CreateDatabaseOptions = {},
): DatabaseHandle {
  const sql = postgres(connectionUrl, {
    max: options.max ?? 10,
    // 全接続の起動時にJSTを固定する。サーバ既定値に依存しない。
    connection: { TimeZone: DATABASE_TIME_ZONE },
  })

  return {
    db: drizzle(sql, { schema }),
    close: async () => {
      await sql.end()
    },
  }
}
